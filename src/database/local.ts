import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
import { Cluster } from '../cluster'

import { CreateDatabaseConfig, CreateUserConfig, Database, DatabaseInstance, DatabaseInstanceConfig, DatabaseUser } from './types'

const POSTGRES_PORT = 5432

export class LocalDatabaseInstance extends DatabaseInstance {
	private readonly id: string
	private readonly namespace: k8s.core.v1.Namespace
	private readonly service: k8s.core.v1.Service
	private readonly postgresVersion: string
	private readonly cluster: Cluster

	constructor(id: string, args: DatabaseInstanceConfig) {
		const postgresVersion = args.postgresVersion || '15'
		const namespaceName = `postgres-${id}`

		const ns = new k8s.core.v1.Namespace(`${id}-ns`, {
			metadata: { name: namespaceName }
		}, { provider: args.cluster.provider })

		const password = new random.RandomPassword(`${id}-password`, {
			length: 24,
			special: false
		})

		const username = args.username || 'postgres'

		const secret = new k8s.core.v1.Secret(`${id}-secret`, {
			metadata: {
				name: 'postgres-credentials',
				namespace: namespaceName
			},
			stringData: {
				'username': username,
				'password': password.result
			}
		}, { dependsOn: [ns], provider: args.cluster.provider })

		const pvc = new k8s.core.v1.PersistentVolumeClaim(`${id}-pvc`, {
			metadata: {
				name: 'postgres-data',
				namespace: namespaceName
			},
			spec: {
				accessModes: ['ReadWriteOnce'],
				resources: {
					requests: { storage: '10Gi' }
				}
			}
		}, { dependsOn: [ns], provider: args.cluster.provider })

		const deployment = new k8s.apps.v1.Deployment(`${id}-deployment`, {
			metadata: {
				name: 'postgres',
				namespace: namespaceName
			},
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: 'postgres' } },
				template: {
					metadata: { labels: { app: 'postgres' } },
					spec: {
						containers: [{
							name: 'postgres',
							image: `postgres:${postgresVersion}-alpine`,
							ports: [{ containerPort: POSTGRES_PORT, name: 'postgres' }],
							env: [
								{
									name: 'POSTGRES_USER',
									valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'username' } }
								},
								{
									name: 'POSTGRES_PASSWORD',
									valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'password' } }
								},
								{
									name: 'PGDATA',
									value: '/var/lib/postgresql/data'
								}
							],
							volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql' }],
							readinessProbe: {
								exec: { command: ['pg_isready', '-U', username] },
								initialDelaySeconds: 5,
								periodSeconds: 5
							},
							livenessProbe: {
								exec: { command: ['pg_isready', '-U', username] },
								initialDelaySeconds: 30,
								periodSeconds: 10
							}
						}],
						volumes: [{
							name: 'data',
							persistentVolumeClaim: { claimName: pvc.metadata.name }
						}]
					}
				}
			}
		}, { dependsOn: [ns, pvc], provider: args.cluster.provider })

		const service = new k8s.core.v1.Service(`${id}-service`, {
			metadata: {
				name: 'postgres',
				namespace: namespaceName
			},
			spec: {
				selector: { app: 'postgres' },
				ports: [{ port: POSTGRES_PORT, targetPort: POSTGRES_PORT, name: 'postgres' }],
				type: 'ClusterIP'
			}
		}, { dependsOn: [deployment], provider: args.cluster.provider })

		const host = pulumi.output(`postgres.${namespaceName}.svc.cluster.local`)

		super(
			host,
			pulumi.output(POSTGRES_PORT),
			pulumi.output(username),
			password.result
		)

		this.id = id
		this.namespace = ns
		this.service = service
		this.postgresVersion = postgresVersion

		this.cluster = args.cluster
	}

	createUser(config: CreateUserConfig): DatabaseUser {
		const password = config.password
			? pulumi.output(config.password)
			: new random.RandomPassword(`${config.id}-password`, {
				length: 24,
				special: false
			}).result

		const namespaceName = this.namespace.metadata.name

		const job = new k8s.batch.v1.Job(`${config.id}-create-user`, {
			metadata: {
				name: `${config.id}-create-user`,
				namespace: namespaceName
			},
			spec: {
				ttlSecondsAfterFinished: 0,
				template: {
					spec: {
						restartPolicy: 'OnFailure',
						initContainers: [{
							name: 'wait-for-postgres',
							image: 'busybox:latest',
							command: ['sh', '-c'],
							args: [namespaceName.apply(ns =>
								`until nc -z -w5 postgres.${ns}.svc.cluster.local ${POSTGRES_PORT}; do echo "Waiting for postgres..."; sleep 2; done`
							)]
						}],
						containers: [{
							name: 'create-user',
							image: `postgres:${this.postgresVersion}-alpine`,
							command: ['/bin/sh', '-c'],
							args: [pulumi.all([password, namespaceName]).apply(([pass, ns]) =>
								`PGPASSWORD=$POSTGRES_PASSWORD psql -h postgres.${ns}.svc.cluster.local -U $POSTGRES_USER -tc "SELECT 1 FROM pg_roles WHERE rolname = '${config.username}'" | grep -q 1 || ` +
								`PGPASSWORD=$POSTGRES_PASSWORD psql -h postgres.${ns}.svc.cluster.local -U $POSTGRES_USER -c "CREATE ROLE \\"${config.username}\\" WITH LOGIN PASSWORD '${pass}'"`
							)],
							env: [
								{
									name: 'POSTGRES_USER',
									valueFrom: { secretKeyRef: { name: 'postgres-credentials', key: 'username' } }
								},
								{
									name: 'POSTGRES_PASSWORD',
									valueFrom: { secretKeyRef: { name: 'postgres-credentials', key: 'password' } }
								}
							]
						}]
					}
				},
				backoffLimit: 4
			}
		}, { dependsOn: [this.service], provider: this.cluster.provider })

		return new DatabaseUser(pulumi.output(config.username), password, job)
	}

	createDatabase(config: CreateDatabaseConfig): Database {
		const namespaceName = this.namespace.metadata.name
		const ownerFlag = config.owner
			? config.owner.username.apply(u => ` -O "${u}"`)
			: pulumi.output('')

		// Create K8s Job to create the database
		const job = new k8s.batch.v1.Job(`${config.id}-create-db`, {
			metadata: {
				name: `${config.id}-create-db`,
				namespace: namespaceName
			},
			spec: {
				ttlSecondsAfterFinished: 0,
				template: {
					spec: {
						restartPolicy: 'OnFailure',
						initContainers: [{
							name: 'wait-for-postgres',
							image: 'busybox:latest',
							command: ['sh', '-c'],
							args: [namespaceName.apply(ns =>
								`until nc -z -w5 postgres.${ns}.svc.cluster.local ${POSTGRES_PORT}; do echo "Waiting for postgres..."; sleep 2; done`
							)]
						}],
						containers: [{
							name: 'createdb',
							image: `postgres:${this.postgresVersion}-alpine`,
							command: ['/bin/sh', '-c'],
							args: [pulumi.all([ownerFlag, namespaceName]).apply(([owner, ns]) =>
								`PGPASSWORD=$POSTGRES_PASSWORD psql -h postgres.${ns}.svc.cluster.local -U $POSTGRES_USER -tc "SELECT 1 FROM pg_database WHERE datname = '${config.name}'" | grep -q 1 || ` +
								`PGPASSWORD=$POSTGRES_PASSWORD createdb -h postgres.${ns}.svc.cluster.local -U $POSTGRES_USER${owner} "${config.name}"`
							)],
							env: [
								{
									name: 'POSTGRES_USER',
									valueFrom: { secretKeyRef: { name: 'postgres-credentials', key: 'username' } }
								},
								{
									name: 'POSTGRES_PASSWORD',
									valueFrom: { secretKeyRef: { name: 'postgres-credentials', key: 'password' } }
								}
							]
						}]
					}
				},
				backoffLimit: 4
			}
		}, { dependsOn: [this.service], provider: this.cluster.provider })

		// Use owner credentials if provided, otherwise use master credentials
		const username = config.owner?.username || this.masterUsername
		const password = config.owner?.password || this.masterPassword

		return new Database(
			pulumi.output(config.name),
			this.host,
			this.port,
			username,
			password,
			job
		)
	}

	allowAccessFrom(_id: string, _securityGroupId: pulumi.Input<string>): void { /* no need for local DB */ }
}

export function createLocalDatabaseInstance(id: string, args: DatabaseInstanceConfig): LocalDatabaseInstance {
	return new LocalDatabaseInstance(id, args)
}
