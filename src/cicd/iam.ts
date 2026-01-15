import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { currentStack, githubConnectorArn, ResourceArgs } from '../types'

// ============================================
// CodeBuild Service Role
// ============================================
export interface CodeBuildRoleConfig {
	appId: string
	ecrMainRepoArn: pulumi.Input<string>
	ecrTasksRepoArn?: pulumi.Input<string>
	sqsQueueArn: pulumi.Input<string>
	secretArns: pulumi.Input<string>[]
}

export function createCodeBuildRole(args: ResourceArgs<CodeBuildRoleConfig>): aws.iam.Role {
	const role = new aws.iam.Role(`${args.appId}-codebuild-role`, {
		name: `${currentStack}-${args.appId}-codebuild-role`,
		assumeRolePolicy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Service: 'codebuild.amazonaws.com' },
				Action: 'sts:AssumeRole'
			}]
		}),
		tags: {
			Name: `${args.appId} CodeBuild Role`,
			stack: currentStack
		}
	})

	new aws.iam.RolePolicy(`${args.appId}-codebuild-logs`, {
		role: role.name,
		policy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: [
					'logs:CreateLogGroup',
					'logs:CreateLogStream',
					'logs:PutLogEvents'
				],
				Resource: '*'
			}]
		})
	})

	const ecrArns: pulumi.Input<string>[] = [args.ecrMainRepoArn]
	if (args.ecrTasksRepoArn) ecrArns.push(args.ecrTasksRepoArn)

	new aws.iam.RolePolicy(`${args.appId}-codebuild-ecr`, {
		role: role.name,
		policy: pulumi.all(ecrArns).apply(arns => JSON.stringify({
			Version: '2012-10-17',
			Statement: [
				{
					Effect: 'Allow',
					Action: ['ecr:GetAuthorizationToken'],
					Resource: '*'
				},
				{
					Effect: 'Allow',
					Action: [
						'ecr:BatchCheckLayerAvailability',
						'ecr:GetDownloadUrlForLayer',
						'ecr:BatchGetImage',
						'ecr:PutImage',
						'ecr:InitiateLayerUpload',
						'ecr:UploadLayerPart',
						'ecr:CompleteLayerUpload'
					],
					Resource: arns
				}
			]
		}))
	})

	new aws.iam.RolePolicy(`${args.appId}-codebuild-sqs`, {
		role: role.name,
		policy: pulumi.output(args.sqsQueueArn).apply(arn => JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: ['sqs:SendMessage'],
				Resource: arn
			}]
		}))
	})

	if (args.secretArns.length > 0) {
		new aws.iam.RolePolicy(`${args.appId}-codebuild-secrets`, {
			role: role.name,
			policy: pulumi.all(args.secretArns).apply(arns => JSON.stringify({
				Version: "2012-10-17",
				Statement: [{
					Effect: "Allow",
					Action: [
						"secretsmanager:GetSecretValue",
						"secretsmanager:DescribeSecret",
					],
					Resource: arns.filter((value, index, arr) => arr.indexOf(value) === index),
				}]
			}))
		})
	}

	new aws.iam.RolePolicy(`${args.appId}-codebuild-connections`, {
		role: role.name,
		policy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: [
					'codestar-connections:UseConnection',
					'codeconnections:UseConnection',
					'codeconnections:GetConnectionToken',
					'codeconnections:GetConnection',
				],
				Resource: githubConnectorArn
			}]
		})
	})

	return role
}

// ============================================
// Manager CodeBuild Role
// ============================================
export interface ManagerCodeBuildRoleConfig {
	ecrRepoArn: pulumi.Input<string>
	sqsQueueArn: pulumi.Input<string>
}

export function createManagerCodeBuildRole(args: ResourceArgs<ManagerCodeBuildRoleConfig>): aws.iam.Role {
	const role = new aws.iam.Role(`cicd-manager-codebuild-role`, {
		name: `${currentStack}-cicd-manager-codebuild-role`,
		assumeRolePolicy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Service: 'codebuild.amazonaws.com' },
				Action: 'sts:AssumeRole'
			}]
		}),
		tags: {
			Name: 'CI/CD Manager CodeBuild Role',
			stack: currentStack
		}
	})

	new aws.iam.RolePolicy(`cicd-manager-codebuild-logs`, {
		role: role.name,
		policy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: [
					'logs:CreateLogGroup',
					'logs:CreateLogStream',
					'logs:PutLogEvents'
				],
				Resource: '*'
			}]
		})
	})

	new aws.iam.RolePolicy(`cicd-manager-codebuild-ecr`, {
		role: role.name,
		policy: pulumi.output(args.ecrRepoArn).apply(arn => JSON.stringify({
			Version: '2012-10-17',
			Statement: [
				{
					Effect: 'Allow',
					Action: ['ecr:GetAuthorizationToken'],
					Resource: '*'
				},
				{
					Effect: 'Allow',
					Action: [
						'ecr:BatchCheckLayerAvailability',
						'ecr:GetDownloadUrlForLayer',
						'ecr:BatchGetImage',
						'ecr:PutImage',
						'ecr:InitiateLayerUpload',
						'ecr:UploadLayerPart',
						'ecr:CompleteLayerUpload'
					],
					Resource: arn
				}
			]
		}))
	})

	new aws.iam.RolePolicy(`cicd-manager-codebuild-sqs`, {
		role: role.name,
		policy: pulumi.output(args.sqsQueueArn).apply(arn => JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: ['sqs:SendMessage'],
				Resource: arn
			}]
		}))
	})

	new aws.iam.RolePolicy(`cicd-manager-codebuild-connections`, {
		role: role.name,
		policy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: [
					'codestar-connections:UseConnection',
					'codeconnections:UseConnection',
					'codeconnections:GetConnectionToken',
					'codeconnections:GetConnection',
				],
				Resource: githubConnectorArn
			}]
		})
	})

	return role
}

// ============================================
// Manager Pod IAM Role (for IRSA)
// ============================================
export interface ManagerPodRoleConfig {
	oidcProviderArn: pulumi.Input<string>
	oidcProviderUrl: pulumi.Input<string>
	sqsQueueArn: pulumi.Input<string>
	namespace: string
	serviceAccountName: string
}

export function createManagerPodRole(args: ResourceArgs<ManagerPodRoleConfig>): aws.iam.Role {
	const role = new aws.iam.Role(`cicd-manager-role`, {
		name: `${currentStack}-cicd-manager-role`,
		assumeRolePolicy: pulumi.all([args.oidcProviderArn, args.oidcProviderUrl])
			.apply(([arn, url]) => {
				// Remove https:// prefix from URL for the condition key
				const issuerUrl = url.replace('https://', '')
				return JSON.stringify({
					Version: '2012-10-17',
					Statement: [{
						Effect: 'Allow',
						Principal: { Federated: arn },
						Action: 'sts:AssumeRoleWithWebIdentity',
						Condition: {
							StringEquals: {
								[`${issuerUrl}:sub`]: `system:serviceaccount:${args.namespace}:${args.serviceAccountName}`,
								[`${issuerUrl}:aud`]: 'sts.amazonaws.com'
							}
						}
					}]
				})
			}),
		tags: {
			Name: 'CI/CD Manager Pod Role',
			stack: currentStack
		}
	})

	// SQS permissions (receive, delete messages)
	new aws.iam.RolePolicy(`cicd-manager-sqs`, {
		role: role.name,
		policy: pulumi.output(args.sqsQueueArn).apply(arn => JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Action: [
					'sqs:ReceiveMessage',
					'sqs:DeleteMessage',
					'sqs:GetQueueAttributes',
					'sqs:ChangeMessageVisibility'
				],
				Resource: arn
			}]
		}))
	})

	return role
}
