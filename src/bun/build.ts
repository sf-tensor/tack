import { readFileSync } from 'fs'
import path from 'path'

function createFileLoad(sourcePath: string, output: string) {
    const contents = readFileSync(sourcePath, 'utf-8')
    const contentsBase64 = Buffer.from(contents, 'utf-8').toString('base64')
    return `echo ${contentsBase64} | base64 -d -o ${output}\n`
}

export function createBuildScript() {
    let script = "#/bin/bash\n\n"
    script += createFileLoad(path.join(__dirname, 'assets', 'Dockerfile'), 'Dockerfile')
    script += createFileLoad(path.join(__dirname, 'assets', 'adapter.js'), 'adapter.js')
    return script
}