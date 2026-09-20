/** 灵动ai：固定 bootstrap 运行在 opaque iframe 内；不向宿主暴露回调，并为沙箱补内存存储。 */
import { decodeText, encodeText } from './bytes.ts'

/** One statically declared local script or stylesheet, already read under the source file's authority. */
export interface HtmlAsset {
  readonly kind: 'script' | 'stylesheet'
  /** Original HTML attribute, not a Host absolute path. */
  readonly reference: string
  readonly data: Uint8Array<ArrayBuffer>
}

/** Complete bytes for one document; dependencies are finite and never requested by iframe messages. */
export interface HtmlBundle {
  readonly data: Uint8Array<ArrayBuffer>
  readonly assets: readonly HtmlAsset[]
}

/**
 * Build the outer iframe document. Its resource URLs are created inside the sandbox,
 * because that opaque origin cannot load resource URLs created by the parent.
 * @param bundle - complete HTML bytes and optional static dependencies.
 * @returns bootstrap HTML; invalid UTF-8 throws before navigation.
 */
export function createHtmlDocument(bundle: HtmlBundle): string {
  const payload = encodeText(JSON.stringify({
    html: decodeText(bundle.data),
    assets: bundle.assets.map(asset => ({ kind: asset.kind, reference: asset.reference, text: decodeText(asset.data) })),
  }))
  return `<!doctype html><meta charset="utf-8"><script>(()=>{
const bytes=data=>Uint8Array.from(atob(data),character=>character.charCodeAt(0));
const text=data=>new TextDecoder('utf-8',{fatal:true}).decode(bytes(data));
const bundle=JSON.parse(text("${payload}"));
const installOpaqueStorage=()=>{
  const create=()=>{const values=new Map();return {
    get length(){return values.size},
    clear(){values.clear()},
    getItem(key){const name=String(key);return values.has(name)?values.get(name):null},
    key(index){return [...values.keys()][index]??null},
    removeItem(key){values.delete(String(key))},
    setItem(key,value){values.set(String(key),String(value))},
  }};
  for(const name of ['localStorage','sessionStorage']){
    try{void globalThis[name]}
    catch{Object.defineProperty(globalThis,name,{value:create(),configurable:true})}
  }
};
installOpaqueStorage();
let html=bundle.html;
if(bundle.assets.length){
  const parsed=new DOMParser().parseFromString(html,'text/html');
  for(const asset of bundle.assets){
    const script=asset.kind==='script';
    const url=URL.createObjectURL(new Blob([asset.text],{type:script?'application/javascript':'text/css'}));
    const attribute=script?'src':'href';
    for(const element of parsed.querySelectorAll(script?'script[src]':'link[rel~="stylesheet" i][href]')){
      if(element.getAttribute(attribute)===asset.reference)element.setAttribute(attribute,url);
    }
  }
  html='<!doctype html>'+parsed.documentElement.outerHTML;
}
document.open();document.write(html);document.close();
})()</script>`
}
