import { execSync } from 'child_process'

/** Demo MFA accounts must start un-enrolled (tests enrol them) and end un-enrolled (so a human can enrol their own). */
export default function reset() {
  execSync(`bun -e "import {teardown} from './tests/e2e/teardown'; await teardown(); process.exit(0)"`, { cwd: process.cwd(), stdio: 'ignore' })
}
