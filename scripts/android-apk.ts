import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Gera o APK assinado do app Android e o deixa em resources/android, que o electron-builder leva no instalador.
// O Kora do PC serve esse APK ao celular (/app/kora-celular.apk); a versão sai do build.gradle.kts, a única fonte.
const android = resolve('android')
const gradle = readFileSync(join(android, 'app', 'build.gradle.kts'), 'utf8')
const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)?.[1])
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1]
if (!versionCode || !versionName) throw new Error('versionCode/versionName não encontrados em android/app/build.gradle.kts')

// O PATH desta máquina tem uma aspa sobrando que quebra o Gradle; tirar não muda nada onde ela não existe.
// Sem JAVA_HOME (o CI define pelo setup-java), usa o Java que vem com o Android Studio.
const studioJava = 'C:/Program Files/Android/Android Studio/jbr'
const env = {
  ...process.env,
  Path: (process.env.Path ?? process.env.PATH ?? '').replaceAll('"', ''),
  JAVA_HOME: process.env.JAVA_HOME ?? (existsSync(studioJava) ? studioJava : undefined)
}
execFileSync(join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', '--quiet'], { cwd: android, env, stdio: 'inherit', shell: process.platform === 'win32' })

const apk = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
// Sem a chave o Gradle gera app-release-unsigned.apk, que o Android não instala por cima do app atual.
if (!existsSync(apk)) throw new Error('APK sem assinatura: falta ~/.kora-celular/keystore.properties ou KORA_KEYSTORE_PROPERTIES')
const out = resolve('resources', 'android')
mkdirSync(out, { recursive: true })
copyFileSync(apk, join(out, 'kora-celular.apk'))
writeFileSync(join(out, 'android.json'), `${JSON.stringify({ versionCode, versionName })}\n`)
console.log(`app do celular ${versionName} (${versionCode}) em resources/android`)
