import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const FLOCI_ENDPOINT = 'http://127.0.0.1:4566'
export const AWS_EMULATOR_ENDPOINT = 'https://127.0.0.1:9297'
export const AWS_EMULATOR_HOME = '/tmp/.aws/emulator/9297'

const configPath = resolve(import.meta.dirname, '../config/aws-endpoint.json')

export function getAwsEndpointConfig() {
  const { endpoint } = JSON.parse(readFileSync(configPath, 'utf8'))
  if (endpoint === FLOCI_ENDPOINT) {
    return { provider: 'floci', endpoint, region: 'ap-northeast-1' }
  }
  if (endpoint === AWS_EMULATOR_ENDPOINT) {
    return { provider: 'aws-emulator', endpoint, region: 'us-west-2' }
  }
  throw new Error(`Unsupported local AWS endpoint: ${String(endpoint)}`)
}

export function getAwsClientConfig() {
  const target = getAwsEndpointConfig()
  return {
    endpoint: target.endpoint,
    region: target.region,
    ...(target.provider === 'floci'
      ? { credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test-only' } }
      : { disableHostPrefix: true }),
  }
}

export function getTestEnvironment(base = process.env) {
  const target = getAwsEndpointConfig()
  const env = {
    PATH: base.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    NODE_ENV: 'test',
    CI: 'true',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    AWS_ENDPOINT_URL: target.endpoint,
    AWS_REGION: target.region,
    AWS_DEFAULT_REGION: target.region,
    AWS_EC2_METADATA_DISABLED: 'true',
  }

  if (target.provider === 'aws-emulator') {
    env.AWS_CONFIG_FILE = `${AWS_EMULATOR_HOME}/config`
    env.AWS_SHARED_CREDENTIALS_FILE = `${AWS_EMULATOR_HOME}/emulator_credentials`
    env.AWS_CA_BUNDLE = `${AWS_EMULATOR_HOME}/ca.pem`
    env.NODE_EXTRA_CA_CERTS = `${AWS_EMULATOR_HOME}/ca.pem`
    env.AWS_DISABLE_HOST_PREFIX_INJECTION = 'true'
  } else {
    env.AWS_ACCESS_KEY_ID = 'local-test'
    env.AWS_SECRET_ACCESS_KEY = 'local-test-only'
  }
  return env
}
