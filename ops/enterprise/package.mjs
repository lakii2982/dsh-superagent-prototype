import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = fileURLToPath(new URL('../../', import.meta.url))
const [, , target, ...extra] = process.argv
if (!target || extra.length || !target.endsWith('.zip')) {
  console.error('Usage: node ops/enterprise/package.mjs <output.zip>')
  process.exit(1)
}
const output = resolve(target)
if (existsSync(output)) throw new Error(`Output already exists: ${output}`)
const outputDirectory = dirname(output)
mkdirSync(outputDirectory, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'dsh-enterprise-package-'))

const run = (program, args, cwd = source) => execFileSync(program, args, { cwd, stdio: 'inherit' })
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')

// Copy the exact installed, platform-independent runtime dependency tree. DSH supplies its own peers.
function vendorRuntime(packageDirectory) {
  const vendor = join(packageDirectory, 'node_modules')
  const versions = new Map()
  function copy(name, parent) {
    const lookup = createRequire(join(parent, 'package.json'))
    const manifestPath = realpathSync(lookup.resolve(`${name}/package.json`))
    const manifest = readJson(manifestPath)
    if (versions.has(name)) {
      if (versions.get(name) !== manifest.version) throw new Error(`Conflicting runtime versions of ${name}`)
      return
    }
    versions.set(name, manifest.version)
    const destination = join(vendor, name)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(dirname(manifestPath), destination, { recursive: true })
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, dirname(manifestPath))
  }
  for (const name of Object.keys(readJson(join(source, 'package.json')).dependencies)) copy(name, source)
  return Object.fromEntries(versions)
}

async function buildMeasurement(release) {
  const require = createRequire(join(source, 'package.json'))
  const tool = createRequire(require.resolve('tsdown')).resolve('rolldown')
  const { rolldown } = await import(pathToFileURL(tool).href)
  const bundle = await rolldown({ input: join(source, 'scripts', 'enterprise-measure.mjs'), platform: 'node' })
  try { await bundle.write({ file: join(release, 'enterprise-measure.mjs'), format: 'es' }) }
  finally { await bundle.close() }
}

try {
  run('pnpm', ['typecheck'])
  run('pnpm', ['test'])
  const operationsDirectory = join(source, 'ops', 'enterprise')
  const operationsTests = readdirSync(operationsDirectory).filter(file => file.endsWith('.test.mjs')).sort()
  if (!operationsTests.length) throw new Error('Release gate requires enterprise operations tests')
  run(process.execPath, ['--test', ...operationsTests.map(file => join(operationsDirectory, file))])
  run('pnpm', ['build'])
  const release = join(temporary, 'dsh-enterprise-release')
  const npmStage = join(temporary, 'npm')
  mkdirSync(release)
  mkdirSync(npmStage)
  const { version } = readJson(join(source, 'package.json'))
  const name = `dsh-superagent-${version}.tgz`
  run('pnpm', ['pack', '--pack-destination', npmStage])
  run('tar', ['-xzf', join(npmStage, name), '-C', npmStage])
  const dependencies = vendorRuntime(join(npmStage, 'package'))
  const runtime = join(release, name)
  run('tar', ['-czf', runtime, '-C', npmStage, 'package'])

  for (const file of ['README.md', 'install.sh', 'dsh-enterprise', 'dsh-enterprise.service', 'configure.mjs', 'company.example.json', 'check-branches.mjs']) {
    cpSync(join(source, 'ops', 'enterprise', file), join(release, file))
  }
  cpSync(join(source, 'LICENSE'), join(release, 'LICENSE'))
  cpSync(join(source, 'docs', '015-release-acceptance.zh-CN.md'), join(release, 'RELEASE-ACCEPTANCE.zh-CN.md'))
  cpSync(join(source, 'examples', 'enterprise-measure.example.json'), join(release, 'enterprise-measure.example.json'))
  await buildMeasurement(release)
  writeFileSync(join(release, 'BUILD-INFO.json'), JSON.stringify({
    pluginVersion: version,
    verifiedDshVersion: '0.2.2-rc.5',
    package: name,
    packageSha256: digest(runtime),
    bundledRuntimeDependencies: dependencies,
  }, null, 2) + '\n')
  const stagedZip = join(temporary, basename(output))
  run('zip', ['-q', '-r', stagedZip, basename(release)], temporary)
  run('unzip', ['-tq', stagedZip])
  cpSync(stagedZip, output, { errorOnExist: true, force: false })
  console.log(output)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
