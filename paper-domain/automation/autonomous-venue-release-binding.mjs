import { verifyAutonomousVenueProfileSelection } from './autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from './autonomous-submission-metadata-contract.mjs';

export function autonomousVenueReleaseBindingFields({
  venueProfileSelection,
  venueProfileValid,
  submissionMetadataReceipt,
  submissionMetadataValid,
} = {}) {
  return Object.freeze({
    venueProfileSelectionHash: venueProfileValid
      ? venueProfileSelection.autonomousVenueProfileSelectionReceiptHash : null,
    venueProfileSelection: venueProfileValid ? venueProfileSelection : null,
    venueProfileRankingReceiptHash: venueProfileValid
      ? venueProfileSelection.rankingReceipt
        ?.autonomousVenueProfileRankingReceiptHash || null : null,
    venueSelectorConfigurationHash: venueProfileValid
      ? venueProfileSelection.rankingReceipt?.selectorConfigurationHash || null : null,
    venueAuthorityConfigurationHash: venueProfileValid
      ? venueProfileSelection.venueAuthorityConfigurationHash || null : null,
    submissionMetadataReceiptHash: submissionMetadataValid
      ? submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash : null,
    submissionMetadataReceipt: submissionMetadataValid ? submissionMetadataReceipt : null,
    submissionMetadataAuthorityConfigurationHash: submissionMetadataValid
      ? submissionMetadataReceipt.submissionMetadataAuthorityConfigurationHash || null : null,
  });
}

export function verifyAutonomousVenueReleaseBinding(binding, renderReceipt, {
  authorityObservedAt = null,
} = {}) {
  const venueSelection = binding?.venueProfileSelection || null;
  const metadataReceipt = binding?.submissionMetadataReceipt || null;
  return verifyAutonomousVenueProfileSelection(venueSelection, { authorityObservedAt })
    && verifyAutonomousSubmissionMetadataReceipt(metadataReceipt, {
      paperId: binding?.paperId,
      protocolFamily: binding?.proposalProtocolFamily,
      authorityObservedAt,
    })
    && venueSelection?.version === 2
    && metadataReceipt?.version === 2
    && binding?.venueProfileSelectionHash
      === venueSelection.autonomousVenueProfileSelectionReceiptHash
    && binding?.submissionMetadataReceiptHash
      === metadataReceipt.autonomousSubmissionMetadataReceiptHash
    && binding?.venueProfileRankingReceiptHash
      === venueSelection.rankingReceipt?.autonomousVenueProfileRankingReceiptHash
    && binding?.venueSelectorConfigurationHash
      === venueSelection.rankingReceipt?.selectorConfigurationHash
    && binding?.venueAuthorityConfigurationHash
      === venueSelection.venueAuthorityConfigurationHash
    && binding?.submissionMetadataAuthorityConfigurationHash
      === metadataReceipt.submissionMetadataAuthorityConfigurationHash
    && binding?.venueProfileSelectionHash === renderReceipt?.venueProfileSelectionHash
    && binding?.submissionMetadataReceiptHash
      === renderReceipt?.submissionMetadataReceiptHash;
}
