'use strict';
/** Integration example, not yet installed in MediaCore. Caller owns confirmation/storage. */
module.exports = function createCloudReferenceAdapter(getApi) {
  function api() {
    const value = getApi();
    if (!value || value.version !== 1) throw Error('Cloud Reference v1 未启用。');
    return value;
  }
  return {
    async pickCandidate(target, {signal} = {}) {
      const cloud = api(), ref = await cloud.pickResource({signal});
      if (!ref || signal?.aborted) return null;
      // Present this handoff in MediaCore's confirmation UI. Do not auto-write.
      return {ref, markdown: cloud.toMarkdown(ref), handoff: cloud.toMediaCoreHandoff(target, [ref])};
    },
    resolve(ref, options) { return api().resolve(ref, options); },
    open(ref, options) { return api().open(ref, options); },
  };
};
