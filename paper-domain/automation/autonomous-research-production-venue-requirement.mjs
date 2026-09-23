import {
  verifyAutonomousVenueProfileSelection,
} from './autonomous-venue-profile-contract.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import { verifyVenueRequirementIr } from './venue-requirement-ir.mjs';
import {
  verifyAutonomousVenueTemplateAssetBundle,
  verifyAutonomousVenueTemplateAssetRecord,
} from './autonomous-venue-template-asset-contract.mjs';

export function verifyAutonomousResearchProductionVenueRequirement(
  preparation,
  { authorityObservedAt = preparation?.observedAt || preparation?.createdAt || null } = {},
) {
  const researchAgendaIr = preparation?.researchAgendaIr || null;
  const selection = preparation?.venueProfileSelection || null;
  const venueRequirementIr = preparation?.venueRequirementIr || null;
  const venueTemplateAsset = preparation?.venueTemplateAsset || null;
  const bundle = selection?.venueTemplateAssetBundle || null;
  const bundleHash = preparation?.venueTemplateAssetBundleHash || null;
  const authorityConfigurationHash =
    preparation?.venueTemplateAssetAuthorityConfigurationHash || null;
  return selection?.version === 2
    && selection?.profile?.version === 3
    && selection?.profile?.externalSubmissionEnabled === true
    && selection?.requireExternalSubmission === true
    && verifyResearchAgendaIr(researchAgendaIr, {
      agendaProductionReceipt: preparation?.researchAgendaProducerReceipt || null,
    })
    && verifyAutonomousVenueProfileSelection(selection, { authorityObservedAt })
    && verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile: selection.profile,
      venueProfileSelection: selection,
      expectedVenueProfileRegistryHash: selection.registryHash,
      expectedVenueAuthorityConfigurationHash: selection.venueAuthorityConfigurationHash,
    })
    && verifyAutonomousVenueTemplateAssetBundle(bundle, {
      registry: selection.registry,
    })
    && verifyAutonomousVenueTemplateAssetRecord(venueTemplateAsset)
    && JSON.stringify(venueTemplateAsset) === JSON.stringify(selection.venueTemplateAsset)
    && venueTemplateAsset.venueId === selection.venueId
    && venueTemplateAsset.templateAssetHash === venueRequirementIr.templateAssetHash
    && bundleHash === bundle.autonomousVenueTemplateAssetBundleHash
    && bundleHash === selection.venueTemplateAssetBundleHash
    && bundleHash === selection.rankingReceipt?.venueTemplateAssetBundleHash
    && bundleHash === selection.registryAuthorityProof?.subjectHash
    && selection.registryAuthorityProof?.subjectKind
      === 'AutonomousVenueTemplateAssetBundle'
    && authorityConfigurationHash === selection.venueAuthorityConfigurationHash
    && authorityConfigurationHash === selection.registryAuthorityProof?.configurationHash;
}
