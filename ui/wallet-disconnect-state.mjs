export const WALLET_SESSION_STATES=Object.freeze({CONNECTED:'CONNECTED',INTENTIONAL_DISCONNECT:'INTENTIONAL_DISCONNECT',PUBLIC_LANDING:'PUBLIC_LANDING',SESSION_EXPIRED:'SESSION_EXPIRED',WALLET_ERROR:'WALLET_ERROR'});

export function createWalletLifecycle({abortAuthenticatedRequests=()=>{},clearSession=()=>{},clearWalletState=()=>{},disconnectProvider=async()=>{},navigate=path=>window.location.replace(path)}={}){
  let current=WALLET_SESSION_STATES.CONNECTED;
  let intentional=false;
  return {
    markConnected(){current=WALLET_SESSION_STATES.CONNECTED;intentional=false},
    markSessionExpired(){if(intentional)return;current=WALLET_SESSION_STATES.SESSION_EXPIRED},
    markWalletError(){if(intentional)return;current=WALLET_SESSION_STATES.WALLET_ERROR},
    shouldIgnoreAuthFailure(){return intentional||current===WALLET_SESSION_STATES.INTENTIONAL_DISCONNECT||current===WALLET_SESSION_STATES.PUBLIC_LANDING},
    state(){return current},
    async disconnectWallet(){
      intentional=true;
      current=WALLET_SESSION_STATES.INTENTIONAL_DISCONNECT;
      abortAuthenticatedRequests();
      clearSession();
      clearWalletState();
      try{await disconnectProvider()}
      finally{current=WALLET_SESSION_STATES.PUBLIC_LANDING;navigate('/index.html')}
    },
  };
}
