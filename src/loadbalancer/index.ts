import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

import { Cluster } from '../cluster'
import { createDnsRecord } from '../dns'
import { createCertificate } from '../certificate'
import { currentStack, isLocalStack } from '../types'

interface LoadBalancerArgs {
	name: string
	cluster: Cluster
	healthCheckPath: string

	rules: {
		host: string;
		routes: { path: string; service: pulumi.Input<string>; port: number }[]
	}[]
}

export function createLoadBalancer(args: LoadBalancerArgs) {
	const config = new pulumi.Config()
	const cloudflareZoneId = config.get('cloudflareZoneId')
	const isLocal = isLocalStack(currentStack)

	// Skip certificates for local stacks
	const hostsWithDomain = args.rules.filter(rule => rule.host)
	const certificates = (!isLocal && cloudflareZoneId)
		? hostsWithDomain.map(rule =>
			createCertificate({
				id: `${args.name}-cert-${rule.host.replace(/\./g, '-')}`,
				domainName: rule.host,
				zoneId: cloudflareZoneId
			})
		)
		: []

	// Build annotations based on stack type
	let annotations: Record<string, pulumi.Input<string>>
	let ingressClassName: string

	if (isLocal) {
		ingressClassName = "nginx"
		annotations = {
			"kubernetes.io/ingress.class": "nginx",
			"nginx.ingress.kubernetes.io/proxy-body-size": "50m",
			"nginx.ingress.kubernetes.io/proxy-read-timeout": "600",
			"nginx.ingress.kubernetes.io/proxy-send-timeout": "600"
		}
	} else {
		ingressClassName = "alb"
		annotations = {
			"kubernetes.io/ingress.class": "alb",
			"alb.ingress.kubernetes.io/scheme": "internet-facing",
			"alb.ingress.kubernetes.io/target-type": "ip",
			"alb.ingress.kubernetes.io/healthcheck-path": args.healthCheckPath
		}

		const httpsEnabled = certificates.length > 0
		if (httpsEnabled) {
			const certificateArns = pulumi.all(certificates.map(c => c.certificateArn)).apply(arns => arns.join(','))
			annotations["alb.ingress.kubernetes.io/listen-ports"] = '[{"HTTP": 80}, {"HTTPS": 443}]'
			annotations["alb.ingress.kubernetes.io/certificate-arn"] = certificateArns
			annotations["alb.ingress.kubernetes.io/ssl-redirect"] = "443"
		}
	}

	const ingress = new k8s.networking.v1.Ingress(args.name, {
		metadata: {
			name: args.name,
			namespace: "default",
			annotations,
		},
		spec: {
			ingressClassName,
			rules: args.rules.map((rule) => ({
				host: rule.host || undefined,  // Allow empty host for local dev
				http: {
					paths: rule.routes.map((route) => ({
						path: route.path,
						pathType: 'Prefix',
						backend: {
							service: {
								name: route.service,
								port: {
									number: route.port
								}
							}
						}
					}))
				}
			}))
		}
	}, { dependsOn: args.cluster.dependencies(), provider: args.cluster.provider })

	const albHostname = isLocal
		? pulumi.output('localhost')
		: ingress.status.apply(status => status?.loadBalancer?.ingress?.[0]?.hostname ?? '')

	const dnsRecords = (!isLocal && cloudflareZoneId)
		? args.rules.filter(rule => rule.host).map(rule =>
			createDnsRecord({
				id: `${args.name}-dns-${rule.host.replace(/\./g, '-')}`,
				recordName: rule.host,
				albHostname,
				zoneId: cloudflareZoneId
			})
		) : []

	return { ingress, albHostname, dnsRecords, certificates }
}