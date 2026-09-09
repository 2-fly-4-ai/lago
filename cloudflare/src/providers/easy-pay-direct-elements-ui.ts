// EPD's public SDK owns every card input. This script handles only field state
// and the opaque cct_ token, never PAN/CVC. Keep the Gateway renderer separate.
// Contract: https://docs.epd.com/guides/card-vaulting/
export function easyPayDirectElementsScript(
  publishableKey: string,
  expectedSandbox: boolean,
): string {
  return `(async()=>{
    let busy=false;let stopped=false;let epd;let fields;
    const status=document.getElementById('payment-status');
    const unavailable=()=>{stopped=true;cardReady=false;refreshPayState();error.textContent='Secure card fields could not be loaded. Refresh the page or contact support.';status.textContent='Secure fields unavailable'};
    const timer=setTimeout(unavailable,15000);
    const sync=()=>{cardReady=!busy&&!stopped&&Object.values(fields).every(field=>{const state=field.getState();return state.complete&&state.valid});refreshPayState()};
    try {
      if(typeof EPD!=='function')throw new Error('SDK unavailable');
      epd=await EPD(${JSON.stringify(publishableKey)},{disableTelemetry:true});
      if(epd.sandbox!==${JSON.stringify(expectedSandbox)})throw new Error('Payment environment mismatch');
      const style={base:{fontFamily:'system-ui,sans-serif',fontSize:'16px',color:'#172033',padding:'13px 14px'},invalid:{color:'#b42318'}};
      fields={number:epd.create('cardNumber',{style,ariaLabel:'Card number',placeholder:'1234 1234 1234 1234'}),expiration:epd.create('cardExpiration',{style,ariaLabel:'Expiration date',placeholder:'MM / YY'}),cvc:epd.create('cardCvc',{style,ariaLabel:'Security code',placeholder:'CVV'})};
      await Promise.all([fields.number.mount('#ccnumber'),fields.expiration.mount('#ccexp'),fields.cvc.mount('#cvv')]);
      if(stopped)return;
      clearTimeout(timer);
      for(const [name,field] of Object.entries(fields))field.on('change',state=>{const container=document.getElementById({number:'ccnumber',expiration:'ccexp',cvc:'cvv'}[name]);container.classList.toggle('is-invalid',!state.empty&&!state.valid);container.setAttribute('aria-invalid',String(!state.empty&&!state.valid));sync()});
      sync();status.textContent='Secure fields ready';
      button.addEventListener('click',async()=>{
        if(busy||stopped||!cardReady||!taxReady)return;
        const emailInput=document.getElementById('email');const phone=document.getElementById('phone');const terms=document.getElementById('terms');
        for(const id of ['first-name','last-name']){const field=document.getElementById(id);if(!field.value.trim()||field.value.trim().length>100){error.textContent='Enter your first and last name';field.focus();return}}
        if(emailInput&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(emailInput.value.trim())){error.textContent='Enter a valid email address';emailInput.focus();return}
        if(!/^\\+[1-9]\\d{7,14}$/.test(phone.value.trim())){error.textContent='Enter a phone number in international format, for example +14155551234';phone.focus();return}
        if(terms&&!terms.checked){error.textContent='Accept the Terms of Service and Privacy Policy to continue';terms.focus();return}
        const quotedCheckout=checkout;const quoteId=taxQuoteId;
        busy=true;sync();error.textContent='';
        let tokenTimer;
        try {
          const capture=await Promise.race([epd.createToken(fields),new Promise((_,reject)=>{tokenTimer=setTimeout(()=>reject(new Error('Capture timed out')),15000)})]);
          if(typeof capture.token!=='string'||!/^cct_[A-Za-z0-9_-]{8,240}$/.test(capture.token))throw new Error('Invalid capture token');
          if(checkout!==quotedCheckout||taxQuoteId!==quoteId||!taxReady)throw new Error('Total changed');
          const submitted=await submit(capture.token);
          if(submitted===true){stopped=true;status.textContent='Payment submitted'}
          else {stopped=true;cardReady=false;status.textContent='Payment status requires confirmation'}
        } catch {error.textContent='Card capture was not completed. Check your details and the current total before trying again.'}
        finally {clearTimeout(tokenTimer);busy=false;sync()}
      });
    } catch {clearTimeout(timer);unavailable()}
  })();`;
}
