import * as k8s from '@pulumi/kubernetes'
import * as pulumi from "@pulumi/pulumi"
import { Cluster } from './cluster'

export function createSecret(
	args: {
		id: string,
		name: string,
		stringData: { [key: string]: string | pulumi.Input<string> },
		namespace?: string,
		cluster: Cluster
	}
): k8s.core.v1.Secret {
	return new k8s.core.v1.Secret(args.id, {
		metadata: {
			name: args.name,
			namespace: args.namespace
		},
		stringData: args.stringData
	}, { provider: args.cluster.provider, dependsOn: args.cluster.dependencies() })
}