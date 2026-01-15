import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

import { Bucket } from './index'
import { type BucketConfig } from './types'

const MINIO_NAMESPACE = 'minio'
const MINIO_ACCESS_KEY = 'minioadmin'
const MINIO_SECRET_KEY = 'minioadmin'
const MINIO_SERVICE_NAME = 'minio'

class MinioInstance {
	public readonly endpoint: pulumi.Output<string>
	public readonly service: k8s.core.v1.Service

	private static instance: MinioInstance | null = null

	private constructor() {
		const ns = new k8s.core.v1.Namespace('minio-ns', {
			metadata: { name: MINIO_NAMESPACE }
		})

		const secret = new k8s.core.v1.Secret('minio-secret', {
			metadata: {
				name: 'minio-credentials',
				namespace: MINIO_NAMESPACE
			},
			stringData: {
				'root-user': MINIO_ACCESS_KEY,
				'root-password': MINIO_SECRET_KEY
			}
		}, { dependsOn: [ns] })

		const deployment = new k8s.apps.v1.Deployment('minio-deployment', {
			metadata: {
				name: MINIO_SERVICE_NAME,
				namespace: MINIO_NAMESPACE
			},
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: MINIO_SERVICE_NAME } },
				template: {
					metadata: { labels: { app: MINIO_SERVICE_NAME } },
					spec: {
						containers: [{
							name: 'minio',
							image: 'minio/minio:latest',
							args: ['server', '/data', '--console-address', ':9001'],
							ports: [
								{ containerPort: 9000, name: 's3' },
								{ containerPort: 9001, name: 'console' }
							],
							env: [
								{ name: 'MINIO_ROOT_USER', valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'root-user' } } },
								{ name: 'MINIO_ROOT_PASSWORD', valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'root-password' } } }
							],
							volumeMounts: [{ name: 'data', mountPath: '/data' }]
						}],
						volumes: [{ name: 'data', emptyDir: {} }]
					}
				}
			}
		}, { dependsOn: [ns] })

		this.service = new k8s.core.v1.Service('minio-service', {
			metadata: {
				name: MINIO_SERVICE_NAME,
				namespace: MINIO_NAMESPACE
			},
			spec: {
				selector: { app: MINIO_SERVICE_NAME },
				ports: [
					{ port: 9000, targetPort: 9000, name: 's3' },
					{ port: 9001, targetPort: 9001, name: 'console' }
				],
				type: 'ClusterIP'
			}
		}, { dependsOn: [deployment] })

		this.endpoint = pulumi.output(`http://${MINIO_SERVICE_NAME}.${MINIO_NAMESPACE}.svc.cluster.local:9000`)
	}

	static getInstance(): MinioInstance {
		if (!MinioInstance.instance) {
			MinioInstance.instance = new MinioInstance()
		}

		return MinioInstance.instance
	}
}

export function createMinioBucket(id: string, args: BucketConfig): Bucket {
	const minio = MinioInstance.getInstance()

	new k8s.batch.v1.Job(`${id}-create-bucket`, {
		metadata: {
			name: `${id}-create-bucket`,
			namespace: MINIO_NAMESPACE
		},
		spec: {
			ttlSecondsAfterFinished: 0,
			template: {
				spec: {
					restartPolicy: 'OnFailure',
					containers: [{
						name: 'mc',
						image: 'minio/mc:latest',
						command: ['/bin/sh', '-c'],
						args: [
							`mc alias set myminio http://${MINIO_SERVICE_NAME}:9000 ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY} && ` +
							`mc mb --ignore-existing myminio/${args.bucketName}`
						]
					}],
					initContainers: [{
						name: 'wait-for-minio',
						image: 'busybox:latest',
						command: ['sh', '-c'],
						args: [
							`until nc -z -w5 ${MINIO_SERVICE_NAME}.${MINIO_NAMESPACE}.svc.cluster.local 9000; do echo "Waiting for minio..."; sleep 2; done`
						]
					}]
				}
			},
			backoffLimit: 4
		}
	}, { dependsOn: [minio.service] })

	return new Bucket({
		endpoint: minio.endpoint,
		name: pulumi.output(args.bucketName),
		accessKey: pulumi.output(MINIO_ACCESS_KEY),
		secretKey: pulumi.output(MINIO_SECRET_KEY)
	}, {})
}