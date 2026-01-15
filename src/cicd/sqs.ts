import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { currentStack, ResourceArgs } from '../types'

export interface DeploymentQueueConfig {
	visibilityTimeoutSeconds?: number  // How long jobs have to complete (default: 900 = 15 min)
	messageRetentionSeconds?: number   // How long to keep messages (default: 86400 = 1 day)
}

export interface DeploymentQueue {
	queue: aws.sqs.Queue
	dlq: aws.sqs.Queue
	queueUrl: pulumi.Output<string>
	queueArn: pulumi.Output<string>
}

export function createDeploymentQueue(args: ResourceArgs<DeploymentQueueConfig>): DeploymentQueue {
	// Dead Letter Queue for failed deployments
	const dlq = new aws.sqs.Queue(`cicd-deployment-dlq`, {
		name: `${currentStack}-cicd-deployment-dlq`,
		messageRetentionSeconds: 1209600, // 14 days
		tags: {
			Name: 'CI/CD Deployment Dead Letter Queue',
			stack: currentStack
		}
	})

	const queue = new aws.sqs.Queue(`cicd-deployment-queue`, {
		name: `${currentStack}-cicd-deployment-queue`,
		visibilityTimeoutSeconds: args.visibilityTimeoutSeconds ?? 900,
		messageRetentionSeconds: args.messageRetentionSeconds ?? 86400,
		receiveWaitTimeSeconds: 20, // Long polling
		redrivePolicy: dlq.arn.apply(arn => JSON.stringify({
			deadLetterTargetArn: arn,
			maxReceiveCount: 3
		})),
		tags: {
			Name: 'CI/CD Deployment Queue',
			stack: currentStack
		}
	})

	return {
		queue,
		dlq,
		queueUrl: queue.url,
		queueArn: queue.arn
	}
}

// SQS message types for the deployment pipeline
export interface DeploymentMessage {
	deploymentId: string        // Unique ID: "{appId}-{commitHash}-{timestamp}"
	appId: string               // Application identifier
	deploymentImage: string     // Full ECR URL for main image
	tasksImage: string          // Full ECR URL for tasks image (empty if no tasks)
	taskCronJobIds: string      // Comma-separated CronJob names
	commitHash: string          // Git commit hash (7 chars)
	timestamp: string           // ISO 8601 timestamp
}
