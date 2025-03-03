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
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from "@aws-cdk/aws-iam";
import * as logs from "@aws-cdk/aws-logs";
import {CfnNagSuppressor} from "./cfn-nag-suppressor";
import * as iamSec from "./iam-permissions";

export interface AnonymousStatisticsProps {
    readonly solutionId: string;
    readonly retrievalTier: string;
    readonly destinationStorageClass: string;
    readonly sendAnonymousSelection: string;
}

export class AnonymousStatistics extends cdk.Construct {

    public sendAnonymousStats: lambda.IFunction;

    constructor(scope: cdk.Construct, id: string, props: AnonymousStatisticsProps) {
        super(scope, id);

        const generateUuid = new lambda.Function(this, 'GenerateUuid', {
            functionName: `${cdk.Aws.STACK_NAME}-generateUuid`,
            description: 'This function generates UUID for each deployment',
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(20),
            code: lambda.Code.fromAsset('lambda/generateUuid')
        });
        CfnNagSuppressor.addLambdaSuppression(generateUuid);

        const genereateUuidTrigger = new cdk.CustomResource(this, 'GenerateUuidTrigger', {
            serviceToken: generateUuid.functionArn
        });

        const sendAnonymousStats = new lambda.Function(this, 'SendAnonymousStats', {
            functionName: `${cdk.Aws.STACK_NAME}-sendAnonymousStats`,
            description: 'This function sends anonymous statistics to the AWS Solutions Builders team',
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            memorySize: 128,
            timeout: cdk.Duration.minutes(5),
            code: lambda.Code.fromAsset('lambda/sendAnonymousStats'),
            environment:{
                UUID: genereateUuidTrigger.getAttString('UUID'),
                REGION: cdk.Aws.REGION,
                SOLUTION_ID: props.solutionId,
                VERSION: '%%VERSION%%',
                STORAGE_CLASS: props.destinationStorageClass,
                RETRIEVAL_TIER: props.retrievalTier,
                SEND_ANONYMOUS_STATISTICS: props.sendAnonymousSelection
            }
        });
        CfnNagSuppressor.addLambdaSuppression(sendAnonymousStats);
        this.sendAnonymousStats = sendAnonymousStats;
    }
}
