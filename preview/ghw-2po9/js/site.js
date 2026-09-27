(function(){
  var top=document.getElementById('top-bar');
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)');
  var clamp=function(x){return Math.min(1,Math.max(0,x))}, pad=function(n){return (n<10?'0':'')+n};
  var raf=0, solid=null;

  // hour clock (home only): plays once on entering view, no pinning.
  // data-max is the end in minutes; #hour-cap data-steps names each stop, data-end is the final line
  var sec=document.getElementById('hour');
  if(sec){
    var clock=document.getElementById('clock'), ring=document.getElementById('ring'), cap=document.getElementById('hour-cap');
    var maxMin=+(sec.dataset.max||60), steps=JSON.parse(cap.dataset.steps), capIdx=-1, last=-1;
    var setClock=function(h){
      var s=Math.round(h*maxMin*60);
      if(s===last) return; last=s;
      clock.textContent=pad(Math.floor(s/60))+':'+pad(s%60);
      ring.setAttribute('stroke-dashoffset',1-h);
      var i=0; steps.forEach(function(st,k){if(k&&s>=(st[0]-(st[0]-steps[k-1][0])/2)*60)i=k;});
      if(i!==capIdx){capIdx=i;cap.textContent=steps[i][1];}
    };
    var finish=function(){setClock(1);if(cap.dataset.end)cap.textContent=cap.dataset.end;};
    var play=function(){
      if(reduce.matches){finish();return;}
      var marks=steps.slice(1).map(function(st){return st[0]/maxMin}), move=700, hold=450, t0=performance.now();
      var frame=function(now){
        var t=now-t0, seg=Math.floor(t/(move+hold));
        if(seg>=marks.length){finish();return;}
        var from=seg?marks[seg-1]:0, k=clamp((t-seg*(move+hold))/move), e=1-Math.pow(1-k,3);
        setClock(from+(marks[seg]-from)*e);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if('IntersectionObserver' in window){
      var io=new IntersectionObserver(function(es){if(es[0].isIntersecting){io.disconnect();play();}},{threshold:.55});
      io.observe(sec.querySelector('.hour-in'));
    } else finish();
  }

  // reveal on scroll, staggered within each group
  var groups=new Map();
  [].forEach.call(document.querySelectorAll('.reveal'),function(el){var p=el.parentElement;var n=groups.get(p)||0;el.style.setProperty('--i',n);groups.set(p,n+1);});
  // reveal when an element's box enters the lower 88% of the screen (a clipped .wipe is measured by its parent)
  var pending=[].map.call(document.querySelectorAll('.reveal,.wipe'),function(el){return{el:el,box:el.classList.contains('wipe')?el.parentElement:el}});
  function reveal(){
    if(!pending.length) return;
    var lim=innerHeight*.88;
    pending=pending.filter(function(o){var r=o.box.getBoundingClientRect();if(r.top<lim&&r.bottom>0){o.el.classList.add('in');return false;}return true;});
  }
  if(reduce.matches){pending.forEach(function(o){o.el.classList.add('in')});pending=[];}

  // pinned story: .story holds .panel items; the active one follows scroll progress
  var stories=[].slice.call(document.querySelectorAll('.story'));
  function tickStories(){
    stories.forEach(function(st){
      var panels=st.querySelectorAll('.panel'), n=panels.length, r=st.getBoundingClientRect();
      if(reduce.matches){[].forEach.call(panels,function(p){p.classList.add('on')});return;}
      var p=clamp(-r.top/(r.height-innerHeight)), a=Math.min(n-1,Math.floor(p*n));
      st.style.setProperty('--p',p);
      [].forEach.call(panels,function(el,k){el.classList.toggle('on',k===a)});
    });
  }

  function update(){
    var s=window.scrollY>60; if(s!==solid){solid=s;top.classList.toggle('solid',s);}
    reveal(); tickStories();
  }
  addEventListener('scroll',function(){cancelAnimationFrame(raf);raf=requestAnimationFrame(update)},{passive:true});
  addEventListener('resize',update); update();
  addEventListener('load',reveal);
  var rvTimer=setInterval(function(){reveal();if(!pending.length)clearInterval(rvTimer);},300);

  // mobile menu
  var btn=document.getElementById('menu-btn'), menu=document.getElementById('mnav');
  if(btn&&menu){
    var setMenu=function(open,focusBtn){btn.setAttribute('aria-expanded',open);menu.classList.toggle('open',open);if(open){menu.querySelector('a').focus();}else if(focusBtn){btn.focus();}};
    btn.addEventListener('click',function(){setMenu(btn.getAttribute('aria-expanded')!=='true')});
    menu.addEventListener('click',function(e){if(e.target.closest('a'))setMenu(false)});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&btn.getAttribute('aria-expanded')==='true')setMenu(false,true)});
  }

  // session finder (services): three answers map to one suggestion. [name, price, why, menu id]
  var picker=document.getElementById('picker');
  if(picker){
    var SV={
      quick:['Quick Fix, 30 min','$60','Thirty minutes on the one area that needs it.','svc-quick'],
      deep60:['Deep Tissue, 60 min','$95','Slow, firm work for the knots training leaves behind.','svc-deep'],
      deep90:['Deep Tissue, 90 min','$140','Time to work legs, hips and back properly.','svc-deep'],
      ther90:['Therapeutic, 90 min','$150','Focused work on your problem spot, plus full-body.','svc-therapeutic'],
      swe60:['Swedish, 60 min','$95','Long, gliding strokes. The classic place to start.','svc-swedish'],
      swe90:['Swedish, 90 min','$130','A longer, slower reset.','svc-swedish'],
      pre60:['Prenatal, 60 min','$135','Fully supported and comfortable.','svc-prenatal'],
      pre90:['Prenatal, 90 min','$190','Fully supported, with extra time.','svc-prenatal'],
      face:['Korean Face Sculpting','$65','Lifts and de-puffs. No needles.','svc-face'],
      mdeep60:['Travel Deep Tissue, 60 min','$140','Firm, focused work without leaving home.','svc-m-deep'],
      mdeep90:['Travel Deep Tissue, 90 min','$210','Firm, focused work, with time to cover it all.','svc-m-deep'],
      mther90:['Travel Therapeutic, 90 min','$225','Your problem spot plus full-body, at home.','svc-m-therapeutic'],
      mswe60:['Travel Swedish, 60 min','$140','The classic, at your place.','svc-m-swedish'],
      mswe90:['Travel Swedish, 90 min','$195','A longer reset, at your place.','svc-m-swedish'],
      mpre60:['Travel Prenatal, 60 min','$200','Fully supported, no driving.','svc-m-prenatal'],
      mpre90:['Travel Prenatal, 90 min','$285','Fully supported, no driving, extra time.','svc-m-prenatal']
    };
    var PICKS={
      studio:{train:{30:'quick',60:'deep60',90:'deep90'},spot:{30:'quick',60:'deep60',90:'ther90'},stress:{30:'quick',60:'swe60',90:'swe90'},prenatal:{30:'pre60',60:'pre60',90:'pre90'},face:{30:'face',60:'face',90:'face'}},
      mobile:{train:{30:'mdeep60',60:'mdeep60',90:'mdeep90'},spot:{30:'mdeep60',60:'mdeep60',90:'mther90'},stress:{30:'mswe60',60:'mswe60',90:'mswe90'},prenatal:{30:'mpre60',60:'mpre60',90:'mpre90'},face:{30:'face',60:'face',90:'face'}}
    };
    var ans={}, steps=picker.querySelectorAll('.pick-step'), result=picker.querySelector('.pick-result'), back=document.getElementById('pick-back');
    var show=function(n){
      [].forEach.call(steps,function(st){st.hidden=+st.dataset.step!==n;});
      result.hidden=n!==4; back.hidden=n===1;
      var target=n===4?result:steps[n-1];
      var first=target.querySelector('button, a'); if(first&&n>1) first.focus({preventScroll:true});
    };
    var note=function(){
      if(ans.need==='prenatal') return 'Victor calls you for a quick 5-minute consult first.';
      if(ans.need==='face'&&ans.where==='mobile') return 'Face sculpting is done at the studio.';
      if(ans.where==='mobile'&&ans.time==='30') return 'Mobile sessions start at 60 minutes. Per-mile fee outside Statesboro.';
      if(ans.where==='mobile') return 'Per-mile fee outside Statesboro.';
      if(ans.need==='stress') return 'Pair it with the salt room: 45 quiet minutes, $70.';
      return '';
    };
    picker.addEventListener('click',function(e){
      var b=e.target.closest('button[data-q]'); if(!b) return;
      ans[b.dataset.q]=b.dataset.v;
      if(b.dataset.q==='need') show(ans.need==='face'?4:2);
      else if(b.dataset.q==='where') show(3);
      else show(4);
      if(!result.hidden){
        var sv=SV[PICKS[ans.where||'studio'][ans.need][ans.time||'60']];
        document.getElementById('pick-name').textContent=sv[0];
        document.getElementById('pick-price').textContent=sv[1];
        document.getElementById('pick-why').textContent=sv[2];
        document.getElementById('pick-menu').setAttribute('href','#'+sv[3]);
        var n=note(), ne=document.getElementById('pick-note'); ne.textContent=n; ne.hidden=!n;
      }
    });
    back.addEventListener('click',function(){ans={};show(1);steps[0].querySelector('button').focus({preventScroll:true});});
  }

  // email signup (contact): placeholder until an email tool is picked, sends nothing
  var sf=document.getElementById('signup-form');
  if(sf){sf.addEventListener('submit',function(e){e.preventDefault();var m=document.getElementById('signup-msg');if(m)m.hidden=false;});}

  // hero video (home, services): load after the page, skip for reduced motion or data saver, pause when off screen
  var v=document.getElementById('hero-vid'), t=document.getElementById('vid-toggle'), userPaused=false;
  if(v&&t){
    var saveData=navigator.connection&&navigator.connection.saveData;
    var label=function(){t.querySelector('span').textContent=v.paused?'Play video':'Pause video';t.querySelector('path').setAttribute('d',v.paused?'M8 5v14l11-7z':'M7 5h4v14H7zM13 5h4v14h-4z');};
    var startVideo=function(){
      if(reduce.matches||saveData) return;
      v.muted=true; v.setAttribute('autoplay','');
      v.src=innerWidth<900?v.dataset.srcSm:v.dataset.srcLg;
      v.play().catch(function(){}); t.hidden=false; label();
      if('IntersectionObserver' in window){new IntersectionObserver(function(es){es.forEach(function(e){if(userPaused)return; if(e.isIntersecting)v.play().catch(function(){}); else v.pause();});}).observe(v);}
    };
    t.addEventListener('click',function(){if(v.paused){userPaused=false;v.play();}else{userPaused=true;v.pause();}label();});
    v.addEventListener('play',label); v.addEventListener('pause',label);
    if(document.readyState==='complete') startVideo(); else addEventListener('load',startVideo);
    if(reduce.addEventListener) reduce.addEventListener('change',function(){if(reduce.matches){v.pause();}update();});
  }
})();
