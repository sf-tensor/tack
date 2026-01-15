export function generateNpmRc(args: {
    authorizations: string[]
    registries: { [key: string]: string }
}) {
    let file = ""
    for (const auth of args.authorizations) {
        file += auth
        file += "\n"
    }

    for (const reg in args.registries) {
        file += `${reg}:registry=${args.registries[reg]}\n`
    }

    return file
}