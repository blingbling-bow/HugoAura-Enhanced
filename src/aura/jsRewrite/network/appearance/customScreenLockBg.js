/// Rewrite rules basic config section begins ///

const type = "localResource";

const urlPattern = "screenLock.js";

/// End of the rewrite rules basic config section ///

let ruleFn = (originalContent, ruleConfig) => {
  const beginAnchor = `t.handleListenScreenLockSource=function(e){var n=`;
  const endAnchor = `;Object(S.a)(n,function(e){var n=P(e||{})`;

  const beginIdx = originalContent.indexOf(beginAnchor);
  const endIdx = originalContent.indexOf(endAnchor, beginIdx);

  if (beginIdx === -1 || endIdx === -1) {
    console.warn(
      `[HugoAura] customScreenLockBg: anchor not found in screenLock.js (beginIdx=${beginIdx}, endIdx=${endIdx}). ` +
        `Returning original content (version mismatch tolerance).`
    );
    return originalContent;
  }

  const injectedExpr = `(function(){
var BS=String.fromCharCode(92);
var c=window.__HUGO_AURA_CONFIG__&&window.__HUGO_AURA_CONFIG__.networkRewrite&&window.__HUGO_AURA_CONFIG__.networkRewrite["appearance/customScreenLockBg"];
var p=c&&c.enabled&&c.backgroundPath;
if(p){
if(/^https?:\\/\\//i.test(p))return p;
return"file:///"+p.split(BS).join(BS+BS)
}
return e&&e.picture?"file:///"+e.picture[0].split(BS).join(BS+BS):""
})()`;

  const before = originalContent.slice(0, beginIdx + beginAnchor.length);
  const after = originalContent.slice(endIdx);

  return before + injectedExpr + after;
};

module.exports = {
  type,
  urlPattern,
  ruleFn,
};
