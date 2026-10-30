/** Model protocol belongs in tool_calls, never in a human chat message. */
export function hasToolMarkup(text:string):boolean{
  return /<\s*\/?\s*[|｜]{1,2}\s*(?:DSML\b|tool(?:▁|_)(?:calls|call)(?:▁|_))/i.test(text);
}
