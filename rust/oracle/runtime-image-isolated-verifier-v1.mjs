// Test-only synthetic attestor. Its temporary key and OCI fixture identities
// never qualify a production rebuild and are not used by the Rust controller.
import crypto from 'node:crypto';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {runtimeImageReproducibilityResponseSigningPayloadHash} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
const H=value=>`sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
export function response(request,verifier,privateKey){
 const profileResults=request.inputs.map(input=>{
  const layerBlobDigests=[H(`${input.profile}:layer-1`),H(`${input.profile}:layer-2`)];
  const oci={indexDigest:H(`${input.profile}:index`),manifestDigest:input.registeredImageDigest,configDigest:H(`${input.profile}:config`),layerBlobDigests,allBlobDigests:[...new Set([input.registeredImageDigest,H(`${input.profile}:config`),...layerBlobDigests])].sort()};oci.ociDigestSetHash=hashRecord('RuntimeImageOciDigestSet',oci);
  return {profile:input.profile,inputClosureHash:input.runtimeImageCanonicalBuildInputClosureHash,contextTarMetadataPolicy:input.contextTarMetadataPolicy,contextTarMetadataPolicyHash:input.contextTarMetadataPolicyHash,contextTarMetadataPolicyApplied:true,dockerfileFrontend:input.dockerfileFrontend,dockerfileFrontendDigest:input.dockerfileFrontendDigest,registeredImage:input.image,registeredImageDigest:input.registeredImageDigest,platform:input.platform,sourceDateEpoch:input.sourceDateEpoch,sourceDateEpochAppliedToBuildkit:true,cacheDisabled:true,ociExporter:input.ociExporter,backendIdentityHash:verifier.backend.backendIdentityHash,buildExecutionClosureHash:hashRecord('RuntimeImageExternalBuildExecutionClosure',{inputClosureHash:input.runtimeImageCanonicalBuildInputClosureHash,backendIdentityHash:verifier.backend.backendIdentityHash}),oci};
 });
 const payload={version:1,kind:'RuntimeImageReproducibilityVerifierResponse',status:'runtime_image_oci_bitwise_rebuild_attested',verifierId:verifier.serviceId,verifierServiceIdentityHash:verifier.serviceIdentityHash,requestHash:request.requestHash,nonce:request.nonce,backend:verifier.backend,backendIdentityHash:verifier.backend.backendIdentityHash,profileResults,signer:verifier.signer,startedAt:request.requestedAt,completedAt:new Date().toISOString()};
 return {...payload,responseHash:hashRecord('RuntimeImageReproducibilityVerifierResponse',payload),signature:crypto.sign(null,Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(payload)),privateKey).toString('base64')};
}
