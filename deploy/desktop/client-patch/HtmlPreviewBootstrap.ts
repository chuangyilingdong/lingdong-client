/** 灵动ai：固定 bootstrap 运行在 opaque iframe 内；不向宿主暴露回调，并为沙箱补内存存储。 */
import { decodeText, encodeBytes, encodeText } from './bytes.ts'

/** One statically declared local script or stylesheet, already read under the source file's authority. */
export interface HtmlAsset {
  readonly kind: 'script' | 'stylesheet' | 'image' | 'binary'
  readonly mime?: string
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
    assets: bundle.assets.map(asset => {
      if (asset.kind === 'script' || asset.kind === 'stylesheet') decodeText(asset.data)
      return { kind: asset.kind, reference: asset.reference, data: encodeBytes(asset.data), mime: asset.mime }
    }),
  }))
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"><script>(()=>{
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
    const bytesForAsset=bytes(asset.data);
    const type=asset.mime||(asset.kind==='script'?'application/javascript':asset.kind==='stylesheet'?'text/css':'application/octet-stream');
    const url=URL.createObjectURL(new Blob([bytesForAsset],{type}));
    if(asset.kind==='script'){
      for(const element of parsed.querySelectorAll('script[src]')){
        if(element.getAttribute('src')===asset.reference)element.setAttribute('src',url);
      }
    }else if(asset.kind==='stylesheet'){
      for(const element of parsed.querySelectorAll('link[rel~="stylesheet" i][href]')){
        if(element.getAttribute('href')===asset.reference)element.setAttribute('href',url);
      }
    }else{
      for(const element of parsed.querySelectorAll('[src],[href],[poster]')){
        for(const attribute of ['src','href','poster']){
          if(element.getAttribute(attribute)===asset.reference)element.setAttribute(attribute,url);
        }
      }
    }
  }
  html='<!doctype html>'+parsed.documentElement.outerHTML;
}
document.open();document.write(html);document.close();
})()</script>`
}
