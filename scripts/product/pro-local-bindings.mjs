/** Public previews never inject private, paid local modes into the Worker. */
/** @param {{command?:string,source?:Record<string,string|undefined>}} [_options] @returns {Record<string,string>} */
export function localProBindings(_options){return {}}
