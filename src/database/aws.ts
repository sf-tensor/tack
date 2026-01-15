import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
import * as path from 'path'
import { execSync } from 'child_process'

import { CreateDatabaseConfig, CreateUserConfig, Database, DatabaseInstance, DatabaseInstanceConfig, DatabaseUser } from './types'
import { currentStack, ResourceArgs } from '../types'

export class RdsDatabaseInstance extends DatabaseInstance {
	private readonly id: string
	private readonly rdsInstance: aws.rds.Instance
	private readonly dbSecurityGroup: aws.ec2.SecurityGroup
	private readonly sqlExecutorLambda: aws.lambda.Function
	private readonly lambdaSecurityGroup: aws.ec2.SecurityGroup
	private readonly vpcSubnetIds: pulumi.Input<string>[]

	constructor(args: ResourceArgs<DatabaseInstanceConfig>) {
		if (!args.networking)	throw new Error('networking configuration is required for production databases')
		if (!args.instanceType)	throw new Error('instanceType is required for production databases')

		const username = args.username
		const postgresVersion = args.postgresVersion
		const storageSize = args.storageSize

		const password = new random.RandomPassword(`${args.id}-password`, {
			length: 32,
			special: true,
			overrideSpecial: '!#$%&*()-_=+[]{}<>:?'
		})

		const snapshotSuffix = new random.RandomString(`${args.id}-snapshot-suffix`, {
			length: 6,
			special: false,
			upper: false,
		})

		const subnetGroup = new aws.rds.SubnetGroup(`${args.id}-subnet-group`, {
			name: `${args.id}-${currentStack}-subnet-group`,
			subnetIds: args.networking.subnets.map(subnet => subnet.subnetId()),
			tags: {
				Name: `${args.id}-subnet-group`,
				stack: currentStack
			}
		})

		const dbSecurityGroup = new aws.ec2.SecurityGroup(`${args.id}-sg`, {
			name: `${args.id}-${currentStack}-rds-sg`,
			description: `Security group for ${args.id} RDS instance`,
			vpcId: args.networking.vpc.vpcId(),
			ingress: [],
			egress: [],
			tags: {
				Name: `${args.id}-rds-sg`,
				stack: currentStack
			}
		})

		const parameterGroup = new aws.rds.ParameterGroup(`${args.id}-params`, {
			family: `postgres${postgresVersion.split('.')[0]}`,
			name: `${args.id}-${currentStack}-params`,
			description: `Parameter group for ${args.id}`,
			parameters: [
				{ name: 'log_statement', value: 'all' },
				{ name: 'log_min_duration_statement', value: '1000' }
			],
			tags: { stack: currentStack }
		})

		const rdsInstance = new aws.rds.Instance(`${args.id}`, {
			identifier: `${args.id}-${currentStack}`,
			instanceClass: args.instanceType,
			allocatedStorage: storageSize,
			engine: 'postgres',
			engineVersion: postgresVersion,

			username: username,
			password: password.result,

			dbSubnetGroupName: subnetGroup.name,
			vpcSecurityGroupIds: [dbSecurityGroup.id],
			parameterGroupName: parameterGroup.name,

			publiclyAccessible: false,
			multiAz: args.multiAz || false,
			storageType: 'gp3',
			storageEncrypted: true,

			backupRetentionPeriod: args.backupRetentionDays ?? 7,
			backupWindow: '03:00-04:00',
			maintenanceWindow: 'Mon:04:00-Mon:05:00',

			deletionProtection: args.deletionProtection ?? (currentStack === 'production'),
			skipFinalSnapshot: currentStack !== 'production',
			finalSnapshotIdentifier: currentStack === 'production'
				? pulumi.interpolate`${args.id}-final-snapshot-${snapshotSuffix.result}`
				: undefined,

			performanceInsightsEnabled: true,
			performanceInsightsRetentionPeriod: 7,

			tags: {
				Name: args.name,
				stack: currentStack,
				database: args.name
			}
		}, { dependsOn: [subnetGroup, dbSecurityGroup, parameterGroup] })

		// Store master credentials in Secrets Manager
		const secret = new aws.secretsmanager.Secret(`${args.id}-secret`, {
			name: `${currentStack}/${args.id}/master-credentials`,
			description: `Database master user credentials for ${args.id}`,
			tags: { stack: currentStack }
		})

		new aws.secretsmanager.SecretVersion(`${args.id}-secret-version`, {
			secretId: secret.id,
			secretString: pulumi.all([
				rdsInstance.address,
				rdsInstance.port,
				password.result
			]).apply(([host, port, pass]) => JSON.stringify({
				host: host,
				port: port,
				username: username,
				password: pass,
			}))
		})

		// Create Lambda for SQL execution
		const lambdaSecurityGroup = new aws.ec2.SecurityGroup(`${args.id}-lambda-sg`, {
			name: `${args.id}-${currentStack}-lambda-sg`,
			description: `Security group for ${args.id} SQL executor Lambda`,
			vpcId: args.networking.vpc.vpcId(),
			egress: [],
			tags: {
				Name: `${args.id} Lambda Security Group`,
				stack: currentStack
			}
		})

		new aws.ec2.SecurityGroupRule(`${args.id}-lambda-to-rds`, {
			type: 'ingress',
			fromPort: 5432,
			toPort: 5432,
			protocol: 'tcp',
			securityGroupId: dbSecurityGroup.id,
			sourceSecurityGroupId: lambdaSecurityGroup.id,
			description: 'Allow SQL executor Lambda access'
		})

		new aws.ec2.SecurityGroupRule(`${args.id}-lambda-egress-to-rds`, {
			type: 'egress',
			fromPort: 5432,
			toPort: 5432,
			protocol: 'tcp',
			securityGroupId: lambdaSecurityGroup.id,
			sourceSecurityGroupId: dbSecurityGroup.id,
			description: 'Allow SQL executor Lambda to connect to RDS'
		})

		const lambdaRole = new aws.iam.Role(`${args.id}-lambda-role`, {
			name: `${args.id}-${currentStack}-sql-executor-role`,
			assumeRolePolicy: JSON.stringify({
				Version: '2012-10-17',
				Statement: [{
					Action: 'sts:AssumeRole',
					Effect: 'Allow',
					Principal: { Service: 'lambda.amazonaws.com' }
				}]
			}),
			tags: {
				Name: `${args.id} SQL Executor Role`,
				stack: currentStack
			}
		})

		new aws.iam.RolePolicyAttachment(`${args.id}-lambda-basic`, {
			role: lambdaRole.name,
			policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
		})

		execSync('npm install', {
			cwd: path.join(__dirname, 'sql-executor-lambda'),
			stdio: 'inherit'
		})

		const sqlExecutorLambda = new aws.lambda.Function(`${args.id}-sql-executor-lambda`, {
			name: `${args.id}-${currentStack}-sql-executor`,
			role: lambdaRole.arn,
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			timeout: 30,
			code: new pulumi.asset.AssetArchive({ '.': new pulumi.asset.FileArchive(path.join(__dirname, 'sql-executor-lambda')) }),
			vpcConfig: {
				subnetIds: args.networking.subnets.map(subnet => subnet.subnetId()),
				securityGroupIds: [lambdaSecurityGroup.id]
			},
			tags: {
				Name: `${args.id} SQL Executor`,
				stack: currentStack
			}
		}, { dependsOn: [lambdaRole] })

		super(
			rdsInstance.address,
			rdsInstance.port,
			pulumi.output(username),
			password.result
		)

		this.id = args.id
		this.rdsInstance = rdsInstance
		this.dbSecurityGroup = dbSecurityGroup
		this.sqlExecutorLambda = sqlExecutorLambda
		this.lambdaSecurityGroup = lambdaSecurityGroup
		this.vpcSubnetIds = args.networking.subnets.map(subnet => subnet.subnetId())
	}

	createUser(config: CreateUserConfig): DatabaseUser {
		const password = config.password
			? pulumi.output(config.password)
			: new random.RandomPassword(`${config.id}-password`, {
				length: 24,
				special: true,
				overrideSpecial: '!#$%&*()-_=+[]{}<>:?'
			}).result

		const invocation = new aws.lambda.Invocation(`${config.id}-create`, {
			functionName: this.sqlExecutorLambda.name,
			input: pulumi.all([
				this.host,
				this.port,
				this.masterUsername,
				this.masterPassword,
				password
			]).apply(([host, port, masterUser, masterPass, userPass]) => JSON.stringify({
				action: 'createUser',
				host,
				port,
				masterUsername: masterUser,
				masterPassword: masterPass,
				username: config.username,
				userPassword: userPass
			}))
		}, { dependsOn: [this.sqlExecutorLambda] })

		return new DatabaseUser(pulumi.output(config.username), password, invocation)
	}

	createDatabase(config: CreateDatabaseConfig): Database {
		const invocation = new aws.lambda.Invocation(`${config.id}-create`, {
			functionName: this.sqlExecutorLambda.name,
			input: pulumi.all([
				this.host,
				this.port,
				this.masterUsername,
				this.masterPassword,
				config.owner.username
			]).apply(([host, port, masterUser, masterPass, dbOwner]) => JSON.stringify({
				action: 'createDatabase',
				host,
				port,
				masterUsername: masterUser,
				masterPassword: masterPass,
				databaseName: config.name,
				owner: dbOwner
			}))
		}, { dependsOn: [this.sqlExecutorLambda, config.owner.invocation] })

		const username = config.owner.username
		const password = config.owner.password

		return new Database(
			pulumi.output(config.name),
			this.host,
			this.port,
			username,
			password,
			invocation
		)
	}

	/**
	 * Allow another security group to access this database
	 */
	allowAccessFrom(id: string, securityGroupId: pulumi.Input<string>): void {
		new aws.ec2.SecurityGroupRule(`${id}-allow-access`, {
			type: 'ingress',
			fromPort: 5432,
			toPort: 5432,
			protocol: 'tcp',
			securityGroupId: this.dbSecurityGroup.id,
			sourceSecurityGroupId: securityGroupId,
			description: `Allow access from ${id}`
		})

		new aws.ec2.SecurityGroupRule(`${id}-egress-to-rds`, {
			type: 'egress',
			fromPort: 5432,
			toPort: 5432,
			protocol: 'tcp',
			securityGroupId: securityGroupId,
			sourceSecurityGroupId: this.dbSecurityGroup.id,
			description: `Allow ${id} to connect to RDS`
		})
	}
}

export function createRdsDatabaseInstance(args: ResourceArgs<DatabaseInstanceConfig>): RdsDatabaseInstance {
	return new RdsDatabaseInstance(args)
}
