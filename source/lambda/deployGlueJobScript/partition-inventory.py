#/*********************************************************************************************************************
# *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                      *
# *                                                                                                                    *
# *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
# *  with the License. A copy of the License is located at                                                             *
# *                                                                                                                    *
# *      http://www.apache.org/licenses/                                                                               *
# *                                                                                                                    *
# *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
# *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
# *  and limitations under the License.                                                                                *
# *********************************************************************************************************************/
#
# @author Solution Builders

import sys
import math
from pyspark.context import SparkContext
from pyspark.sql.window import Window
from pyspark.sql.functions import row_number
from awsglue.dynamicframe import DynamicFrame
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from awsglue.transforms import *

# @params: [JOB_NAME]
args = getResolvedOptions(sys.argv, ['JOB_NAME', 'DATABASE', 'INVENTORY_TABLE', 'FILENAME_TABLE', 'OUTPUT_TABLE', 'STAGING_BUCKET', 'DQL', 'ARCHIVE_COUNT', 'VAULT_SIZE'])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
logger = glueContext.get_logger()

job = Job(glueContext)
job.init(args['JOB_NAME'], args)

DATABASE=args['DATABASE']
INVENTORY_TABLE=args['INVENTORY_TABLE']
FILENAME_TABLE=args['FILENAME_TABLE']
OUTPUT_TABLE=args['OUTPUT_TABLE']
STAGING_BUCKET=args['STAGING_BUCKET']
DQL=int(args['DQL'])
ARCHIVE_COUNT=int(args['ARCHIVE_COUNT'])
VAULT_SIZE=int(args['VAULT_SIZE'])

logger.info('DQL           : {}'.format(DQL))
logger.info('Vault size    : {}'.format(VAULT_SIZE))
logger.info('Archive count : {}'.format(ARCHIVE_COUNT))

DEFAULT_PARTITION_SIZE=10000

# Determines if the partition size needs to be reduced
# to achieve 8 partitions per day minimum.
# For large vaults with smaller number of archives.
def get_partition_size(archive_count, vault_size):

    days = math.ceil(vault_size/DQL)
    logger.info('Estimated days: {}'.format(days))

    if (days * 8 * DEFAULT_PARTITION_SIZE) < archive_count:
        logger.info('Number of partitions per day')
        return DEFAULT_PARTITION_SIZE
    else:
        return math.ceil(archive_count / 8 / days)

partiton_size = get_partition_size(ARCHIVE_COUNT, VAULT_SIZE)
logger.info('Partition size    : {}'.format(partiton_size))

inventory = glueContext.create_dynamic_frame.from_catalog(database = DATABASE, table_name = INVENTORY_TABLE).toDF()
filelist  = glueContext.create_dynamic_frame.from_catalog(database = DATABASE, table_name = FILENAME_TABLE)
mapped = filelist.apply_mapping([("archiveid", "string", "archiveid", "string"), ("override", "string", "override", "string")]).toDF().dropDuplicates(['archiveid'])

rownum = inventory.withColumn("row_num", row_number().over(Window.orderBy(inventory['creationdate'],inventory['archiveid'])).cast("long"))
merged = rownum.join(mapped, "archiveid", how='left_outer') 

frame = DynamicFrame.fromDF(merged, glueContext , "merged")

def transform(rec):
  rec["part"] = rec["row_num"]//partiton_size
  rec["archivedescription"] = rec["override"] if rec["override"] and rec["override"].strip() else rec["archivedescription"]
  rec.pop('override', None)
  return rec

trans0 = Map.apply(frame = frame, f = transform)

sink = glueContext.getSink(connection_type="s3", path='s3://'+STAGING_BUCKET+'/partitioned/', enableUpdateCatalog=True, partitionKeys=["part"])
sink.setFormat("glueparquet")
sink.setCatalogInfo(catalogDatabase=DATABASE, catalogTableName=OUTPUT_TABLE)
sink.writeFrame(trans0)

job.commit()