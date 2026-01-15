import * as pulumi from '@pulumi/pulumi'
import { Vpc } from '../networking/vpc'
import { Subnet } from '../networking/subnet'
import { Cluster } from '../cluster'

/**
 * Configuration for creating a database instance (the server)
 */
export interface DatabaseInstanceConfig {
	name: string
	instanceType: string
	postgresVersion: string
	storageSize: number		/** Storage size in GB */
	username: string		/** Master username */

	/** Networking configuration (required for production) */
	networking: {
		vpc: Vpc
		subnets: Subnet[]
	}

	deletionProtection?: boolean	/** Enable deletion protection (default: true for production) */
	multiAz?: boolean				/** Enable multi-AZ deployment (default: false) */
	backupRetentionDays?: number	/** Backup retention period in days (default: 7 for prod, 0 for dev) */

	cluster: Cluster
}

/**
 * Configuration for creating a database user
 */
export interface CreateUserConfig {
	id: string
	username: string
	password?: pulumi.Input<string> /** Auto-generated if not provided */
}

/**
 * Configuration for creating a database
 */
export interface CreateDatabaseConfig {
	id: string
	name: string
	owner: DatabaseUser
}

/**
 * Represents a database user with credentials
 */
export class DatabaseUser {
	readonly username: pulumi.Output<string>
	readonly password: pulumi.Output<string>
	readonly invocation: pulumi.Resource

	constructor(username: pulumi.Output<string>, password: pulumi.Output<string>, invocation: pulumi.Resource) {
		this.invocation = invocation
		this.username = username
		this.password = password
	}
}

/**
 * Represents a database with connection information
 */
export class Database {
	readonly job: pulumi.Resource
	readonly name: pulumi.Output<string>
	readonly host: pulumi.Output<string>
	readonly port: pulumi.Output<number>
	readonly username: pulumi.Output<string>
	readonly password: pulumi.Output<string>

	constructor(
		name: pulumi.Output<string>,
		host: pulumi.Output<string>,
		port: pulumi.Output<number>,
		username: pulumi.Output<string>,
		password: pulumi.Output<string>,
		job: pulumi.Resource
	) {
		this.job = job
		this.name = name
		this.host = host
		this.port = port
		this.username = username
		this.password = password
	}

	get connectionString(): pulumi.Output<string> {
		return pulumi.all([
			this.username,
			this.password,
			this.host,
			this.port,
			this.name
		]).apply(([user, pass, host, port, db]) =>
			`postgres://${user}:${pass}@${host}:${port}/${db}`
		)
	}

	getEnvVar(): pulumi.Output<string> {
		return pulumi.all([
			this.connectionString,
			this.host,
			this.port,
			this.username,
			this.password,
			this.name
		]).apply(([connStr, host, port, user, pass, db]) => JSON.stringify({
			connectionString: connStr,
			host,
			port,
			username: user,
			password: pass,
			database: db
		}))
	}
}

/**
 * Abstract base class for database instances
 */
export abstract class DatabaseInstance {
	readonly host: pulumi.Output<string>
	readonly port: pulumi.Output<number>
	readonly masterUsername: pulumi.Output<string>
	readonly masterPassword: pulumi.Output<string>

	constructor(
		host: pulumi.Output<string>,
		port: pulumi.Output<number>,
		masterUsername: pulumi.Output<string>,
		masterPassword: pulumi.Output<string>
	) {
		this.host = host
		this.port = port
		this.masterUsername = masterUsername
		this.masterPassword = masterPassword
	}

	abstract createUser(config: CreateUserConfig): DatabaseUser
	abstract createDatabase(config: CreateDatabaseConfig): Database

	/**
	 * Allow another security group to access this database.
	 * No-op for local instances, implemented in RdsDatabaseInstance.
	 */
	abstract allowAccessFrom(_id: string, _securityGroupId: pulumi.Input<string>): void
}
