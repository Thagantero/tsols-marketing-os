const driveConfig = {
  clientId: import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID,
  developerKey: import.meta.env.VITE_GOOGLE_PICKER_API_KEY,
  projectNumber: import.meta.env.VITE_GOOGLE_PROJECT_NUMBER,
};
export const driveConfigured = Object.values(driveConfig).every(Boolean);

type PickResult = {action:string;docs?:{id:string;name:string;mimeType:string}[]};
type PickerBuilder = {
  addView(view:unknown):PickerBuilder;
  setAppId(id:string):PickerBuilder;
  setDeveloperKey(key:string):PickerBuilder;
  setOAuthToken(token:string):PickerBuilder;
  setCallback(cb:(result:PickResult)=>void):PickerBuilder;
  build():{setVisible(value:boolean):void};
};
type DriveWindow = Window & {
  gapi?:{load(name:string,options:{callback:()=>void;onerror:()=>void;timeout:number;ontimeout:()=>void}):void};
  google?:{
    accounts:{oauth2:{initTokenClient(config:{client_id:string;scope:string;callback:(result:{access_token?:string})=>void;error_callback:()=>void}):{requestAccessToken():void}}};
    picker?:{DocsView:new ()=>{setMimeTypes(types:string):unknown};PickerBuilder:new ()=>PickerBuilder;Action:{PICKED:string;CANCEL:string}};
  };
};
const driveWindow = window as DriveWindow;
let ready:Promise<void> | undefined;

function script(url:string) {
  return new Promise<void>((resolve,reject) => {
    const element = document.createElement('script');
    const timeout = window.setTimeout(() => {element.remove();reject(new Error('Google Drive did not load.'));},12000);
    element.src = url;
    element.async = true;
    element.onload = () => {clearTimeout(timeout);resolve();};
    element.onerror = () => {clearTimeout(timeout);element.remove();reject(new Error('Google Drive could not load.'));};
    document.head.append(element);
  });
}

export function prepareDrive() {
  if (!driveConfigured) return Promise.reject(new Error('Google Drive is not configured.'));
  ready ??= Promise.all([
    driveWindow.gapi ? Promise.resolve() : script('https://apis.google.com/js/api.js'),
    driveWindow.google?.accounts ? Promise.resolve() : script('https://accounts.google.com/gsi/client'),
  ]).then(() => new Promise<void>((resolve,reject) => {
    const fail = () => reject(new Error('Google Picker did not load.'));
    if (!driveWindow.gapi) {fail();return;}
    driveWindow.gapi.load('picker',{callback:resolve,onerror:fail,timeout:12000,ontimeout:fail});
  })).catch(error => {ready=undefined;throw error;});
  return ready;
}

export function pickDriveImage() {
  return new Promise<{file:Blob;name:string}|null>((resolve,reject) => {
    const google = driveWindow.google;
    const picker = google?.picker;
    const fail = () => reject(new Error('Google Drive sign-in or file selection did not complete.'));
    if (!picker || !google?.accounts) {fail();return;}
    const client = google.accounts.oauth2.initTokenClient({
      client_id:driveConfig.clientId,scope:'https://www.googleapis.com/auth/drive.file',error_callback:fail,
      callback:({access_token:token}) => {
        if (!token) {fail();return;}
        const view = new picker.DocsView().setMimeTypes('image/jpeg,image/png,image/webp');
        new picker.PickerBuilder().setAppId(driveConfig.projectNumber).setDeveloperKey(driveConfig.developerKey)
          .setOAuthToken(token).addView(view).setCallback(async result => {
            if (result.action === picker.Action.CANCEL) {resolve(null);return;}
            if (result.action !== picker.Action.PICKED) return;
            const item = result.docs?.[0];
            if (!item) {fail();return;}
            try {
              const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?alt=media`, {
                headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000),
              });
              if (!response.ok || Number(response.headers.get('Content-Length')) > 8388608) throw new Error();
              const blob = await response.blob();
              resolve({file:new Blob([blob],{type:item.mimeType}),name:item.name});
            } catch {reject(new Error('Could not download the selected image. Check access and the 8 MB limit.'));}
          }).build().setVisible(true);
      },
    });
    client.requestAccessToken();
  });
}
