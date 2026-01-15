import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { Bucket } from './index'

import { BucketConfig, LifecycleRule } from './types'
import { currentStack, ResourceArgs } from '../types'

export function createS3Bucket(args: ResourceArgs<BucketConfig>): Bucket {
	const bucket = new aws.s3.Bucket(args.id, {
		bucket: args.bucketName,
		tags: { stack: currentStack  }
	}, { dependsOn: args.deps })

	if (!args.isPublic) {
		new aws.s3.BucketPublicAccessBlock(`${args.id}-pab`, {
			bucket: bucket.id,
			region: bucket.region,
			blockPublicAcls: true,
			blockPublicPolicy: true,
			ignorePublicAcls: true,
			restrictPublicBuckets: true
		}, { dependsOn: [bucket] })
	}

	return new Bucket({
		endpoint: pulumi.interpolate`https://${bucket.bucketRegionalDomainName}`,
		name: bucket.bucket,
	}, { bucket: bucket })
}

export function addS3LifecycleRules(id: string, bucket: aws.s3.Bucket, rules: LifecycleRule[]) {
	new aws.s3.BucketLifecycleConfiguration(id, {
		bucket: bucket.bucket,
		region: bucket.region,
		rules: rules.map((rule) => ({
			id: rule.id,
			status: "Enabled",
			filter: rule.filter,
			transitions: rule.transitions
		}))
	}, { dependsOn: [bucket] })
}