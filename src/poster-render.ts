export const posterSizes = {'1:1':[1080,1080],'4:5':[1080,1350],'9:16':[1080,1920],'16:9':[1600,900]} as const;
export type PosterRatio = keyof typeof posterSizes;

function wrapText(context:CanvasRenderingContext2D,text:string,maxWidth:number) {
  const lines:string[] = [];
  for (const word of text.trim().split(/\s+/)) {
    if (lines.length && context.measureText(`${lines.at(-1)} ${word}`).width <= maxWidth) {
      lines[lines.length-1] += ` ${word}`;
      continue;
    }
    let chunk = '';
    for (const character of word) {
      if (chunk && context.measureText(chunk+character).width > maxWidth) {lines.push(chunk);chunk='';}
      chunk += character;
    }
    if (chunk) lines.push(chunk);
  }
  return lines;
}

export async function renderPoster(canvas:HTMLCanvasElement,ratio:PosterRatio,details:{
  headline:string;offer:string;price:string;cta:string;colour:string;accent:string;
},photo?:ImageBitmap,logo?:ImageBitmap) {
  const [width,height] = posterSizes[ratio];
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d');
  if (!context) throw new Error('This browser could not create a poster preview.');
  context.fillStyle=details.colour;
  context.fillRect(0,0,width,height);
  if (photo) {
    const scale=Math.max(width/photo.width,height/photo.height);
    context.drawImage(photo,(width-photo.width*scale)/2,(height-photo.height*scale)/2,photo.width*scale,photo.height*scale);
    const shade=context.createLinearGradient(0,height*.15,0,height);
    shade.addColorStop(0,'transparent');shade.addColorStop(.95,'#071121f8');
    context.fillStyle=shade;
    context.fillRect(0,0,width,height);
  }
  const margin=Math.round(width*.075);
  context.fillStyle=details.accent;
  context.fillRect(margin,margin,Math.round(width*.105),Math.round(height*.008));
  if (logo) {
    const scale=Math.min(width*.2/logo.width,height*.13/logo.height);
    const logoW=logo.width*scale,logoH=logo.height*scale;
    context.fillStyle='#fff';context.fillRect(width-margin-logoW-28,margin,logoW+28,logoH+28);
    context.drawImage(logo,width-margin-logoW-14,margin+14,logoW,logoH);
  }
  const bodySize=Math.round(Math.min(width,height)*.042);
  const bodyStep=bodySize*1.2;
  const textWidth=width-2*margin;
  context.font=`600 ${bodySize}px system-ui`;
  const copy=[details.offer,details.price,details.cta].filter(Boolean).flatMap(line => wrapText(context,line,textWidth));
  let headlineSize=Math.round(Math.min(width,height)*.09);
  let headline:string[];
  do {
    context.font=`800 ${headlineSize}px system-ui`;
    headline=wrapText(context,details.headline,textWidth);
    if (headline.length*headlineSize*1.05+copy.length*bodyStep < height*.67) break;
    headlineSize-=4;
  } while (headlineSize >= 22);
  context.fillStyle='#fff';
  context.textBaseline='top';
  const headlineStep=headlineSize*1.05;
  let y=height-margin-copy.length*bodyStep-headline.length*headlineStep-(copy.length ? bodySize*.6 : 0);
  for (const line of headline) {context.fillText(line,margin,y);y+=headlineStep;}
  y+=bodySize*.6;
  context.font=`600 ${bodySize}px system-ui`;
  for (const line of copy) {context.fillText(line,margin,y);y+=bodyStep;}
  return new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not export the poster.')),'image/jpeg',.92));
}
