const HOSTS=new Set(['oauth-login.cloud.huawei.com','auth.biandangroup.com','driveapis.cloud.huawei.com.cn']);
/** Native desktop transport avoids depending on third-party CORS configuration. */
export function createDesktopFetch(nodeRequire){
  return async(input,options={})=>{
    const url=new URL(input);
    if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.port)throw new Error('便单请求目标不受支持');
    if(typeof nodeRequire!=='function')throw new Error('云端连接需要思源桌面客户端');
    const https=nodeRequire('node:https');
    const {Buffer}=nodeRequire('node:buffer');
    return new Promise((resolve,reject)=>{
      if(options.signal?.aborted){reject(new DOMException('请求已取消','AbortError'));return;}
      const request=https.request(url,{method:options.method||'GET',headers:options.headers||{}},response=>{
        let text='',size=0;
        response.setEncoding('utf8');
        response.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>16*1024*1024){response.destroy();reject(new Error('便单响应超过读取上限'));}else text+=chunk;});
        response.on('error',()=>reject(new Error('便单网络响应中断')));
        response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,headers:{get:key=>response.headers[key.toLowerCase()]},json:async()=>JSON.parse(text),text:async()=>text}));
      });
      request.setTimeout(30000,()=>request.destroy(new Error('便单请求超时，请核查结果后刷新')));
      const abort=()=>request.destroy(new Error('请求已取消'));
      options.signal?.addEventListener('abort',abort,{once:true});
      request.on('close',()=>options.signal?.removeEventListener('abort',abort));
      request.on('error',()=>reject(new Error('便单网络连接失败或超时；写操作请先刷新核查')));
      if(options.body)request.write(options.body.toString());
      request.end();
    });
  };
}
