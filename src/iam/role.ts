import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export function createOidcRole(args: { name: string; oidcProviderArn: pulumi.Input<string>; oidcProviderUrl: pulumi.Input<string>; namespace: string; serviceAccount: string }) {
    return new aws.iam.Role(args.name, {
		name: args.name,
		assumeRolePolicy: pulumi.all([
			args.oidcProviderArn,
			args.oidcProviderUrl
		]).apply(([oidcProviderArn, oidcProviderUrl]) => {
			const issuerUrl = oidcProviderUrl.replace('https://', '')
			return JSON.stringify({
				Version: "2012-10-17",
				Statement: [{
					Effect: "Allow",
					Principal: {
						Federated: oidcProviderArn
					},
					Action: "sts:AssumeRoleWithWebIdentity",
					Condition: {
						StringEquals: {
							[`${issuerUrl}:sub`]: `system:serviceaccount:${args.namespace}:${args.serviceAccount}`,
							[`${issuerUrl}:aud`]: "sts.amazonaws.com",
						}
					}
				}]
			})
		})
	})
}