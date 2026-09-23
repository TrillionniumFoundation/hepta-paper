function anchor(value) {
  return Object.freeze(value);
}

// Source-reviewed anchors for the already-issued Campaign 52-56 control
// journals. These pins do not replace an external signature authority; they
// prevent a journal writer from presenting a newly recomputed chain as one of
// the historical attempts accepted by this release.
export const AUTONOMOUS_RESEARCH_ONE_SHOT_HISTORICAL_ATTEMPT_ANCHORS =
  Object.freeze({
    'autonomous-research:local-auto-20260730-52': anchor({
      attemptId: 'campaign-52-dacd91d3726ce0e67a6f0a9a',
      idempotencyKey:
        'sha256:7a6f561e4657c5874f7fdc8d32250cfa561b1e17dacd91d3726ce0e67a6f0a9a',
      reservationHash:
        'sha256:75ef2f16698ed87825afecb66c41e50a6eb7f78a1eb6b406b6e6419dcbe8bb5e',
      headEventHash:
        'sha256:7ffa7e09a2b9b7387c368dd1bf1bfe902ec8e7923268209ad23076699c0b6c9d',
      headSequence: 5,
      eventChainHash:
        'sha256:eca208f0455c2260e6da7b0f7a28bbee153a2c4aeb4c097bd099f6b0852785a5',
      terminalReceiptHash:
        'sha256:d012cbd37c01405040b314e339245dda04dd0fcdafd9992a2703a9769cebdadf',
    }),
    'autonomous-research:local-auto-20260730-53': anchor({
      attemptId: 'campaign-53-09fcf9a4178d5e1a99331904',
      idempotencyKey:
        'sha256:c06c6da7090aa9fb2c2958fc3c85b11577fbadaf09fcf9a4178d5e1a99331904',
      reservationHash:
        'sha256:df09f4c1da1092e44137c8e873250de20c64210bea1d69f9f006112afa146fa3',
      headEventHash:
        'sha256:920a772956fff4ce25d721d9b677071a9c9039a9c20d7d5ddf3248c438e9a66d',
      headSequence: 7,
      eventChainHash:
        'sha256:47b507316d39e4500282caf0ee3d00e4e477e49a07e1af3154375b0056dc26a3',
      terminalReceiptHash:
        'sha256:4c18f13f7d81db977e0b68f9d97f875c8737258daeddb29e235189ae27091fe6',
    }),
    'autonomous-research:local-auto-20260730-54': anchor({
      attemptId: 'campaign-54-5da6ea8d36624de100360a29',
      idempotencyKey:
        'sha256:4201ac78b2cd37c6908f5a5d6d4eed5a1a8980d75da6ea8d36624de100360a29',
      reservationHash:
        'sha256:99777f5da03ddb83b1569484d12c19d3c83580472cb93b2fc521aad3301cc74c',
      headEventHash:
        'sha256:9efae5b04a8a69861c713a8bcaadcbf3038b2e07e91b57888522145e78659b26',
      headSequence: 7,
      eventChainHash:
        'sha256:a47aa88c4f2acb74b27257b8f63486da4e8de18154a02077c0fa7710536e5d5e',
      terminalReceiptHash:
        'sha256:d6aeabc4921a6b685c777c362d50726dc10785c1023eeb911fea0971018b101c',
    }),
    'autonomous-research:local-auto-20260730-55': anchor({
      attemptId: 'campaign-55-ff74f869e8a9d73a3fc328f8',
      idempotencyKey:
        'sha256:d7b5c2b2f50fc8eb5034cbe424cdc4d6e580abdfff74f869e8a9d73a3fc328f8',
      reservationHash:
        'sha256:7859d5ac55f52a9f8b04a785996976b02254e4ec53d3ae27d4f9d5554e62ef29',
      headEventHash:
        'sha256:98b9ff6c814c9749965aeae1a403ffc5716f7c36edad054fd42207c50d2291e1',
      headSequence: 7,
      eventChainHash:
        'sha256:9a9786bd72a060c661f37340d8e60197a1c01c06454f4b130587b3169a0d31fc',
      terminalReceiptHash:
        'sha256:3796bec4c6de99955430abcab8af825a8c8394f9a4f06bf672990ecc76f7f98d',
    }),
    'autonomous-research:local-auto-20260730-56': anchor({
      attemptId: 'campaign-56-17c5a908dae67e0d86dac273',
      idempotencyKey:
        'sha256:06fd83307c83b42a24156ce5071340245bc8022317c5a908dae67e0d86dac273',
      reservationHash:
        'sha256:38dda7ed6749341fb771d302fa58593853fadd2d3f823e28d00ea0ce2e3412e3',
      headEventHash:
        'sha256:3f9e8b74718362f3677c5150120b882c128587c518f215b175681da221337e7b',
      headSequence: 5,
      eventChainHash:
        'sha256:13e61dcebc73a24e07efa33c8ad268fc5ac604242eebd09a251ef36f665ec243',
      terminalReceiptHash:
        'sha256:7b4a020bf981b6e99db17c1a32b5baf23840a7f10de3cd3d7948f08635b832a1',
    }),
  });
