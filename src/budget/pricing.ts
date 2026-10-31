/** Published standard cache-miss input price is the reference for existing token units.
 * https://api-docs.deepseek.com/quick_start/pricing/ (2026-11-01)
 * This conversion does not create an additional wallet or reset raw model usage. */
export const NETWORK_USD_PER_REQUEST=0.00075;
export function networkPricing(model:string){
  const inputUsdPerMillion=model==='deepseek-v4-pro'?1.32:0.30;
  return {reference:'standard_uncached_input',inputUsdPerMillion,usdPerRequest:NETWORK_USD_PER_REQUEST,tokensPerRequest:Math.ceil(NETWORK_USD_PER_REQUEST*1e6/inputUsdPerMillion)};
}
