// Collect.js has no callback attempt identifier. After a timeout, retire this
// page instead of allowing a late callback to charge during a subsequent retry.
export function easyPayDirectCollectRecoveryScript(): string {
  return `const collectRecovery=(()=>{
let retired=false,pending=false,accepted=false,clickedIdentity=null;
const quotePending=()=>typeof quoteButton!=='undefined'&&quoteButton&&quoteButton.disabled;
const identity=()=>JSON.stringify([checkout,typeof taxQuoteId==='undefined'?null:taxQuoteId,typeof billingAddress==='function'?billingAddress():null]);
const recovery=document.createElement('button');
recovery.type='button';recovery.textContent='Reload secure card fields';recovery.hidden=true;
error.insertAdjacentElement('afterend',recovery);
recovery.addEventListener('click',()=>{
  if(!retired||accepted)return;
  const next=new URL('/easy_pay_direct/payment_form',location.origin);
  next.searchParams.set('checkout',checkout);
  if(returnTo)next.searchParams.set('return_to',returnTo);
  location.assign(next.toString());
});
button.addEventListener('click',(event)=>{
  if(retired||pending||accepted||!cardReady||!taxReady||quotePending()){event.preventDefault();event.stopImmediatePropagation();return}
  const phone=document.getElementById('phone');const email=document.getElementById('email');const terms=document.getElementById('terms');
  if((phone&&!/^\\+[1-9]\\d{7,14}$/.test(phone.value.trim()))||(email&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email.value.trim()))||(terms&&!terms.checked)){
    error.textContent='Check your email, international phone number and acceptance of the terms before paying.';
    event.preventDefault();event.stopImmediatePropagation();return;
  }
  clickedIdentity=identity();pending=true;
},true);
return {
validationCallback:(field,valid,message)=>{
  const id={ccnum:'ccnumber',ccnumber:'ccnumber',ccexp:'ccexp',cvv:'cvv'}[field];
  const container=id&&document.getElementById(id);
  if(container){container.classList.toggle('is-invalid',!valid);container.setAttribute('aria-invalid',String(!valid))}
  if(retired||accepted)return;
  if(!valid&&message)error.textContent=message;
  else if(valid)error.textContent='';
},
timeoutCallback:()=>{
  if(retired||accepted)return;
  retired=true;pending=false;cardReady=false;refreshPayState();
  error.textContent='The secure card fields timed out. Reload them to try again. No payment was submitted by this form.';
  recovery.hidden=false;
  document.getElementById('payment-status').textContent='Secure fields need reloading';
},
fieldsAvailableCallback:()=>{
  if(retired||accepted)return;
  cardReady=true;refreshPayState();document.getElementById('payment-status').textContent='Secure fields ready';
},
callback:(response)=>{
  if(retired||accepted||!pending)return;
  if(!taxReady||quotePending()||identity()!==clickedIdentity){
    retired=true;pending=false;cardReady=false;refreshPayState();recovery.hidden=false;
    error.textContent='Your checkout total or billing details changed. Reload the secure fields and review the total before paying.';
    return;
  }
  accepted=true;pending=false;cardReady=false;refreshPayState();
  const recover=()=>{retired=true;accepted=false;cardReady=false;refreshPayState();recovery.textContent='Reload checkout status';recovery.hidden=false;};
  void Promise.resolve(submit(response.token)).then(completed=>{if(completed!==true)recover()},recover);
}
};})();`;
}
