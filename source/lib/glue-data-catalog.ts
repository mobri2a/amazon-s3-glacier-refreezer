/*********************************************************************************************************************
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * @author Solution Builders
 */

'use strict';

import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as glue from '@aws-cdk/aws-glue';
import * as lambda from '@aws-cdk/aws-lambda';
import * as athena from '@aws-cdk/aws-athena';
import {readFileSync} from 'fs';
import {CfnNagSuppressor} from "./cfn-nag-suppressor";

export interface GlueDataProps {
    readonly stagingBucket: s3.IBucket;
}

export class GlueDataCatalog extends cdk.Construct {
    public readonly inventoryDatabase: glue.IDatabase;
    public readonly inventoryTable: glue.ITable;
    public readonly partitionedInventoryTable: glue.ITable;
    public readonly filelistTable: glue.ITable;
    public readonly athenaWorkgroup: athena.CfnWorkGroup;

    constructor(scope: cdk.Construct, id: string, props: GlueDataProps) {
        super(scope, id);

        const toLowercase = new lambda.Function(this, 'toLowercase', {
            functionName: `${cdk.Aws.STACK_NAME}-toLowercase`,
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(readFileSync('lambda/toLowercase/index.js', 'utf-8'))
        });
        CfnNagSuppressor.addLambdaSuppression(toLowercase);

        const toLowercaseTrigger = new cdk.CustomResource(this, 'toLowercaseTrigger', {
            serviceToken: toLowercase.functionArn,
            properties: { stack_name: cdk.Aws.STACK_NAME }
        })

        // database
        this.inventoryDatabase = new glue.Database(this, 'InventoryDatabase',
        {
            databaseName: `${toLowercaseTrigger.getAttString('stack_name')}-inventory`
        });

        // inventory table
        const inventoryTable = new glue.Table(this, 'InventoryTable',
        {
            tableName: `${toLowercaseTrigger.getAttString('stack_name')}-grf-inventory`,
            database: this.inventoryDatabase,
            columns: [{
                name: 'archiveid',
                type: glue.Schema.STRING,
              }, {
                name: 'archivedescription',
                type: glue.Schema.STRING,
              }, {
                name: 'creationdate',
                type: glue.Schema.STRING,
              }, {
                name: 'size',
                type: glue.Schema.BIG_INT,
              }, {
                name: 'sha256treehash',
                type: glue.Schema.STRING,
              }],
              dataFormat: {
                  inputFormat: glue.InputFormat.TEXT,
                  outputFormat: glue.OutputFormat.HIVE_IGNORE_KEY_TEXT,
                  serializationLibrary: glue.SerializationLibrary.OPEN_CSV
              },
              bucket: props.stagingBucket,
              s3Prefix: 'inventory/'
        });

        const cfnInventoryTable = inventoryTable.node.defaultChild as glue.CfnTable;
        cfnInventoryTable.addOverride('Properties.TableInput.Parameters.skip\\.header\\.line\\.count','1');
        cfnInventoryTable.addOverride('Properties.TableInput.StorageDescriptor.SerdeInfo.Parameters.escapeChar','\\');
        cfnInventoryTable.addOverride('Properties.TableInput.StorageDescriptor.SerdeInfo.Parameters.quoteChar','"');

        // filename override table
        const filelistTable = new glue.Table(this, 'FilelistTable',
        {
            tableName:  `${toLowercaseTrigger.getAttString('stack_name')}-grf-filelist`,
            database: this.inventoryDatabase,
            columns: [{
                name: 'archiveid',
                type: glue.Schema.STRING,
              }, {
                name: 'override',
                type: glue.Schema.STRING,
              }],
              dataFormat: {
                  inputFormat: glue.InputFormat.TEXT,
                  outputFormat: glue.OutputFormat.HIVE_IGNORE_KEY_TEXT,
                  serializationLibrary: glue.SerializationLibrary.OPEN_CSV
              },
              bucket: props.stagingBucket,
              s3Prefix: 'filelist/'
        });

        // partitioned inventory table
        const partitionedinventoryTable = new glue.Table(this, 'PartitionedinventoryTable',
        {
            tableName:  `${toLowercaseTrigger.getAttString('stack_name')}-grf-inventory-partitioned`,
            database: this.inventoryDatabase,
            columns: [{
                name: 'archiveid',
                type: glue.Schema.STRING,
              }, {
                name: 'archivedescription',
                type: glue.Schema.STRING,
              }, {
                name: 'creationdate',
                type: glue.Schema.STRING,
              }, {
                name: 'size',
                type: glue.Schema.BIG_INT,
              }, {
                name: 'sha256treehash',
                type: glue.Schema.STRING,
              }, {
                name: 'row_num',
                type: glue.Schema.BIG_INT,
              }],
              partitionKeys: [{
                name: 'part',
                type: glue.Schema.BIG_INT
              }],
              dataFormat: {
                  inputFormat: glue.InputFormat.PARQUET,
                  outputFormat: glue.OutputFormat.PARQUET,
                  serializationLibrary: glue.SerializationLibrary.PARQUET
              },
              bucket: props.stagingBucket,
              s3Prefix: 'partitioned/'
        });

        const cfnPartitionedinventoryTable = partitionedinventoryTable.node.defaultChild as glue.CfnTable;
        cfnPartitionedinventoryTable.addOverride('Properties.TableInput.Parameters.parquet\\.compression','SNAPPY');

        this.inventoryTable = inventoryTable;
        this.filelistTable = filelistTable;
        this.partitionedInventoryTable = partitionedinventoryTable;

        // Athena Workgroup
        this.athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkgroup',
        {
           name: `${cdk.Aws.STACK_NAME}-glacier-refreezer-sol`,
           recursiveDeleteOption: true,
           state: 'ENABLED',
           workGroupConfiguration:
             {
                enforceWorkGroupConfiguration: true,
                resultConfiguration: {
                    outputLocation: `s3://${props.stagingBucket.bucketName}/results`
                }
             }
        });

        this.athenaWorkgroup.addOverride('Properties.WorkGroupConfiguration.EngineVersion.SelectedEngineVersion','Athena engine version 2');
    }
}
