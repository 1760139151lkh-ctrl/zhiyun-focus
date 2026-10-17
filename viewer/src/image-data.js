// Images arrive from the local capture bridge as data, not network resources.
// Decode them directly so the host page's connect-src policy is irrelevant.
export function imageDataBlob(image){
  const header=typeof image==='string'&&/^data:(image\/(?:png|jpeg));base64,/.exec(image);
  if(!header)throw Error('图片格式不可用，原图仍保存在学习记录中。');
  let decoded;
  try{decoded=atob(image.slice(header[0].length));}catch{throw Error('图片数据不完整，原图仍保存在学习记录中。');}
  if(!decoded.length)throw Error('图片内容为空，原图仍保存在学习记录中。');
  const bytes=new Uint8Array(decoded.length);
  for(let index=0;index<decoded.length;index++)bytes[index]=decoded.charCodeAt(index);
  return new Blob([bytes],{type:header[1]});
}
