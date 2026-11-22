import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { coverage, formatCount, formatMoney, labelCadence, periodLabel, reportMetrics, type Report } from './report-model.ts';

const pageWidth=595.28,pageHeight=841.89,padding=47;
const navy=rgb(.055,.13,.24),teal=rgb(.045,.41,.38),gray=rgb(.30,.36,.43),line=rgb(.87,.91,.94);

function printable(value:string,font:PDFFont){
  return Array.from(value.normalize('NFC')).map(char=>{
    try{font.encodeText(char);return char;}
    catch{return char==='\n'?'\n':'?';}
  }).join('');
}
function wrap(value:string,font:PDFFont,size:number,width:number){
  const result:string[]=[];
  for(const paragraph of printable(value,font).split('\n')){
    let lineText='';
    for(const word of paragraph.trim().split(/\s+/)){
      const combined=lineText?lineText+' '+word:word;
      if(font.widthOfTextAtSize(combined,size)<=width){lineText=combined;continue;}
      if(lineText)result.push(lineText);
      lineText='';
      for(const character of word){
        if(font.widthOfTextAtSize(lineText+character,size)>width){result.push(lineText);lineText='';}
        lineText+=character;
      }
    }
    result.push(lineText);
  }
  return result;
}

export async function buildReportPdf(report:Report){
  const pdf=await PDFDocument.create();
  pdf.setTitle(labelCadence(report.cadence)+' marketing report - '+report.client_name);
  pdf.setAuthor('Thagana Solutions');
  pdf.setCreationDate(new Date(report.created_at));
  pdf.setModificationDate(new Date(report.updated_at));
  const normal=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  let page=pdf.addPage([pageWidth,pageHeight]);
  let y=0;

  function header(first:boolean){
    page.drawRectangle({x:0,y:pageHeight-112,width:pageWidth,height:112,color:navy});
    page.drawRectangle({x:padding,y:pageHeight-35,width:19,height:3,color:rgb(.33,.85,.75)});
    page.drawText('TSOLS  /  THAGANA SOLUTIONS',{x:padding+28,y:pageHeight-39,size:9,font:bold,color:rgb(.74,.94,.91)});
    page.drawText((first?labelCadence(report.cadence)+' marketing report':'Marketing report continued'),
      {x:padding,y:pageHeight-75,size:22,font:bold,color:rgb(1,1,1)});
    y=pageHeight-144;
  }
  function fit(height:number){
    if(y-height>=62)return;
    page=pdf.addPage([pageWidth,pageHeight]);header(false);
  }
  function text(value:string,size=10,color=gray,font=normal){
    for(const item of wrap(value,font,size,pageWidth-padding*2)){
      fit(size+5);
      page.drawText(item,{x:padding,y,size,font,color});
      y-=size+5;
    }
  }
  function heading(value:string){
    fit(43);y-=9;
    page.drawLine({start:{x:padding,y:y+5},end:{x:pageWidth-padding,y:y+5},thickness:.6,color:line});
    y-=13;text(value,13,teal,bold);
  }
  header(true);
  text(report.client_name,16,navy,bold);
  text(periodLabel(report)+'  |  Version '+report.version+(report.status==='draft'?'  |  Draft':''));
  heading('Performance snapshot');
  for(const [label,value] of reportMetrics(report.metrics)){
    fit(18);
    page.drawText(printable(label,normal),{x:padding,y,size:10,font:normal,color:gray});
    const safe=printable(value,bold);
    page.drawText(safe,{x:pageWidth-padding-bold.widthOfTextAtSize(safe,10),y,size:10,font:bold,color:navy});
    y-=17;
  }
  if(report.metrics.ad_native_spend.length){
    heading('Spend in original currencies');
    for(const item of report.metrics.ad_native_spend)text(formatMoney(item.amount,item.currency));
  }
  if(report.metrics.top_campaigns.length){
    heading('Top campaigns by clicks');
    for(const item of report.metrics.top_campaigns){
      fit(35);text(item.name,10,navy,bold);
      text(item.account_label+' | '+formatCount(item.clicks)+' clicks | '+formatMoney(item.native_spend,item.currency),9);
    }
  }
  heading('Key observations');
  text(report.observations.trim()||'No observations recorded.');
  heading(report.cadence==='weekly'?'Next week’s action plan':'Next month’s strategy');
  text(report.action_plan.trim()||'No actions recorded.');
  heading('Data coverage');
  for(const item of coverage(report)){text(item,9);y-=4;}

  pdf.getPages().forEach((current,index,all)=>{
    current.drawLine({start:{x:padding,y:41},end:{x:pageWidth-padding,y:41},thickness:.6,color:line});
    current.drawText('TSOLS  /  CLIENT REPORT',{x:padding,y:25,size:8,font:bold,color:teal});
    current.drawText(String(index+1)+' / '+all.length,{x:pageWidth-padding-26,y:25,size:8,font:normal,color:gray});
  });
  return pdf.save();
}
