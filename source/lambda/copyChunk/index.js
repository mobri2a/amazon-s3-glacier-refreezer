/*********************************************************************************************************************
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                      *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/                                                                               *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * @author Solution Builders
 */

'use strict';

const AWS = require('aws-sdk');
const glacier = new AWS.Glacier();
const s3 = new AWS.S3();

const db = require('./lib/db.js');
const trigger = require('./lib/trigger.js');

const {
    VAULT,
    STAGING_BUCKET,
    STAGING_BUCKET_PREFIX
} = process.env;

async function handler(event){

    let request = JSON.parse(event.Records[0].body)
    let {
        jobId,
        uploadId,
        archiveId,
        key,
        partNo,
        startByte,
        endByte
    } = request

    console.log(`chunk upload ${key} - ${partNo} : ${startByte}-${endByte}`)

    // if sgt present, all chunks have been copied (and multipart closed!)
    // but the message has been triggered, indicating retry. Proceed to trigger Treehash
    // if UplaodId exists - upload part
    let statusRecord = await db.getStatusRecord(archiveId)

    statusRecord.Attributes = statusRecord.Item
    if (statusRecord.Attributes.sgt && statusRecord.Attributes.sgt.S) {
        console.log(`${key} : upload has already been processed`)
        await trigger.calcHash(statusRecord)
        return
    }

    let glacierStream = glacier.getJobOutput({
        accountId: "-",
        jobId: jobId,
        range: `bytes=${startByte}-${endByte}`,
        vaultName: VAULT
    }).createReadStream()

    glacierStream.length = endByte - startByte + 1;

    let uploadResult = await s3.uploadPart({
        UploadId: uploadId,
        Bucket: STAGING_BUCKET,
        Key: `${STAGING_BUCKET_PREFIX}/${key}`,
        PartNumber: partNo,
        Body: glacierStream
    }).promise()

    let etag = uploadResult.ETag;
    let cc = parseInt(statusRecord.Attributes.cc.N)

    console.log(`${key}  - ${partNo}: updating chunk etag : ${etag}`)
    statusRecord = await db.updateChunkStatusGetLatest(archiveId, partNo, etag)

    let count = 0
    for (const entry in statusRecord.Attributes) {
        if (entry.includes("chunk") &&
            statusRecord.Attributes[entry].S) {
            count++
        }
    }

    // [ CHECK IF ALL CHUNKS ARE COMPLETED ]
    if (count < cc) return

    console.log(`${key}  - ${partNo}: all chunks processed`)
    await closeMultipartUpload(key, uploadId, statusRecord)

    console.log(`${key} : setting complete timestamp`)
    await db.setTimestampNow(statusRecord.Attributes.aid.S, "sgt")

    await trigger.calcHash(statusRecord)
}

async function closeMultipartUpload(key, multipartUploadId, statusRecord) {

    let cc = parseInt(statusRecord.Attributes.cc.N)

    console.log(`${key} : closing off multipart upload`)
    let etags = []

    Array.from(Array(cc)).forEach((_, i) => {
        const chunkId = i + 1
        let entry = statusRecord.Attributes[`chunk${chunkId}`].S
        etags.push({
            PartNumber: chunkId,
            ETag: entry
        })
    });

    console.log(`ETAGS: ${JSON.stringify(etags)}`)

    let complete = await s3.completeMultipartUpload({
        Bucket: STAGING_BUCKET,
        Key: `${STAGING_BUCKET_PREFIX}/${key}`,
        UploadId: multipartUploadId,
        MultipartUpload: {
            Parts: etags
        }
    }).promise()
}

module.exports = {
    handler
};
