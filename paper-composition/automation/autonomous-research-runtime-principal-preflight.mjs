import {
  preflightCodexResearchAuthor,
} from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import {
  preflightCodexFormalReviewer,
} from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import {
  preflightAutonomousEmpiricalRuntimes,
} from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import {
  inspectAutonomousResearchAuthorIdentity,
  readAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  preflightReviewerPrincipalPool as defaultPreflightReviewerPrincipalPool,
} from './reviewer-principal-pool-composition.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function errorCode(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 512);
}

export function inspectConfiguredAutonomousResearchAuthorIdentity({
  environment = process.env,
  author,
  clock = { now: () => new Date() },
} = {}) {
  const configPath = String(
    environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG || '',
  ).trim();
  const expectedConfigurationHash = String(
    environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH || '',
  ).trim().toLowerCase();
  if (!configPath && !expectedConfigurationHash) return null;
  if (!configPath || !SHA256.test(expectedConfigurationHash)) {
    throw new Error('autonomous_research_author_identity_configuration_pin_invalid');
  }
  if (!author) {
    throw new Error('autonomous_research_author_identity_preflight_required');
  }
  return inspectAutonomousResearchAuthorIdentity({
    configuration: readAutonomousResearchAuthorIdentityConfiguration({
      configPath,
      expectedConfigurationHash,
    }),
    author,
    now: clock.now(),
    expectedConfigurationHash,
  });
}

export function inspectAutonomousResearchRuntimePrincipals({
  authorConfiguration,
  reviewerConfiguration,
  refereeCount,
  environment = process.env,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
  preflightEmpiricalRuntime = preflightAutonomousEmpiricalRuntimes,
  preflightReviewerPrincipalPool = defaultPreflightReviewerPrincipalPool,
  spawnSyncImpl = undefined,
  clock = { now: () => new Date() },
} = {}) {
  const blockers = [];
  let author = null;
  let reviewer = null;
  let reviewerPrincipalPoolInspection = null;
  let authorIdentityAttestation = null;
  let empiricalRuntimeCapabilityInspection = null;
  try {
    empiricalRuntimeCapabilityInspection = preflightEmpiricalRuntime({
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch (error) {
    blockers.push(`autonomous_empirical_runtime_preflight_failed:${errorCode(error)}`);
  }
  try {
    author = preflightAuthor({
      ...authorConfiguration,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch (error) {
    blockers.push(`autonomous_research_author_preflight_failed:${errorCode(error)}`);
  }
  try {
    authorIdentityAttestation = inspectConfiguredAutonomousResearchAuthorIdentity({
      environment,
      author,
      clock,
    });
  } catch (error) {
    const code = errorCode(error);
    blockers.push(code === 'autonomous_research_author_identity_configuration_pin_invalid'
      ? code
      : `autonomous_research_author_identity_preflight_failed:${code}`);
  }
  const reviewerPrincipalPoolConfigPath = String(
    environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '',
  ).trim();
  if (author && reviewerPrincipalPoolConfigPath) {
    try {
      reviewerPrincipalPoolInspection = preflightReviewerPrincipalPool({
        configPath: reviewerPrincipalPoolConfigPath,
        authorProvider: authorConfiguration.provider,
        authorCodexHome: author.codexHome || authorConfiguration.codexHome,
        environment,
        preflightReviewer,
        authorIdentityAttestation,
        clock,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
      const primaryReviewer = reviewerPrincipalPoolInspection.entries.find((entry) => (
        entry.descriptor.roles.includes('formal-review')
      ));
      reviewer = primaryReviewer ? Object.freeze({
        ...primaryReviewer.preflight,
        effectivePrincipalId: primaryReviewer.descriptor.principalId,
      }) : null;
      if (reviewerPrincipalPoolInspection.pool.reviewerPrincipalCount < refereeCount
        || reviewerPrincipalPoolInspection.pool.reviewerTrustDomainCount < refereeCount) {
        blockers.push(
          'autonomous_research_reviewer_pool_referee_coverage_insufficient',
        );
      }
    } catch (error) {
      blockers.push(`autonomous_research_reviewer_pool_preflight_failed:${errorCode(error)}`);
    }
  } else if (author) {
    try {
      reviewer = preflightReviewer({
        ...reviewerConfiguration,
        authorProvider: authorConfiguration.provider,
        authorCodexHome: author.codexHome || authorConfiguration.codexHome,
        environment,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
    } catch (error) {
      blockers.push(`autonomous_research_reviewer_preflight_failed:${errorCode(error)}`);
    }
  } else {
    blockers.push('autonomous_research_reviewer_preflight_requires_author');
  }
  return Object.freeze({
    author,
    reviewer,
    reviewerPrincipalPoolInspection,
    authorIdentityAttestation,
    empiricalRuntimeCapabilityInspection,
    empiricalPluginStartupInspection:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
    blockers: Object.freeze(blockers),
  });
}
