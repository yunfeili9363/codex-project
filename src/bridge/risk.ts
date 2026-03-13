import type { RiskEvaluator } from './interfaces.js';
import type { RiskEvaluation, TaskRunRecord, WorkspaceRecord } from './types.js';

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /\b(rm\s+-rf|del\s+\/f|format\s+c:|mkfs|shutdown|reboot)\b/i, flag: 'system_destructive_command' },
  { pattern: /\b(delete|remove|purge)\b.{0,25}\b(all|entire|whole|mass|bulk)\b/i, flag: 'mass_delete_intent' },
  { pattern: /\b(secret|token|password|private key|credential|api key)\b/i, flag: 'credential_sensitive_intent' },
  { pattern: /\b(chmod|chown|sudo|launchctl|systemctl)\b/i, flag: 'privileged_system_command' },
  { pattern: /\b(rewrite|rename|refactor)\b.{0,25}\b(entire|whole|all files|project)\b/i, flag: 'large_scale_rewrite' },
];

export class DefaultRiskEvaluator implements RiskEvaluator {
  evaluate(task: TaskRunRecord, workspace: WorkspaceRecord): RiskEvaluation {
    const flags: string[] = [];

    if (workspace.highRisk) {
      flags.push('workspace_marked_high_risk');
    }
    if (task.sandbox === 'danger-full-access') {
      flags.push('danger_full_access');
    }

    for (const entry of HIGH_RISK_PATTERNS) {
      if (entry.pattern.test(task.prompt)) {
        flags.push(entry.flag);
      }
    }

    const uniqueFlags = Array.from(new Set(flags));
    const requiresApproval = uniqueFlags.length > 0;
    const summary = requiresApproval
      ? `Approval required: ${uniqueFlags.join(', ')}`
      : 'No approval required';

    return {
      requiresApproval,
      flags: uniqueFlags,
      summary,
    };
  }
}
