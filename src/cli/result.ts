import type { CliResult } from '../runtime/execute';
import type { Report } from './types';

export type Outcome =
    | {
          kind: 'report';
          report: Report;
          exitCode: number;
      }
    | {
          kind: 'error';
          message: string;
          exitCode: number;
      };

/**
 * Interpret one CLI run. stdout is read as JSON whatever the exit code: exit 1 with a full report
 * (blocked actions, row errors, unreachable WABAs) is normal content and is rendered. Only
 * `{ok:false, error}` or output that is not a report (e.g. a usage error, which the CLI prints to
 * stderr even with `--json`) count as errors.
 * @param result the collected process result
 * @returns {Outcome} the report or an error message
 */
export function interpretResult(result: CliResult): Outcome {
    const json = result.json as { command?: unknown; error?: unknown } | undefined;
    if (json && typeof json === 'object' && typeof json.error === 'string') {
        return { kind: 'error', message: json.error, exitCode: result.exitCode };
    }
    if (json && typeof json === 'object' && typeof json.command === 'string') {
        return { kind: 'report', report: json as Report, exitCode: result.exitCode };
    }
    const detail = result.stderr.trim() || result.stdout.trim();
    const firstBlock = detail.split(/\r?\n\r?\n/, 1)[0] ?? '';
    return {
        kind: 'error',
        message: firstBlock || `wabadev ended with exit code ${result.exitCode} and no output.`,
        exitCode: result.exitCode,
    };
}
