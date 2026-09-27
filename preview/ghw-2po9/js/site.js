(function(){
  var top=document.getElementById('top-bar');
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)');
  var clamp=function(x){return Math.min(1,Math.max(0,x))}, pad=function(n){return (n<10?'0':'')+n};
  var raf=0, solid=null;

  // hour clock (home only)
  // data-max sets the clock's end in minutes (60 on home); #hour-cap data-steps swaps the caption at each stop
  var sec=document.getElementById('hour'), clock=document.getElementById('clock'), ring=document.getElementById('ring'), last=-1;
  var maxMin=sec?+(sec.dataset.max||60):60, cap=document.getElementById('hour-cap'), steps=cap?JSON.parse(cap.dataset.steps):null, capIdx=-1;
  function setClock(h){
    var total=maxMin*60, s=Math.round(h*total);
    if(s===last) return; last=s;
    clock.textContent=pad(Math.floor(s/60))+':'+pad(s%60);
    ring.setAttribute('stroke-dashoffset',1-h);
    if(steps){
      var i=0; steps.forEach(function(st,k){if(k&&s>=(st[0]-(st[0]-steps[k-1][0])/2)*60)i=k;});
      if(i!==capIdx){capIdx=i;cap.textContent=steps[i][1];}
    }
  }
  function tickClock(){
    if(!sec) return;
    if(reduce.matches){setClock(1);return;}
    var r=sec.getBoundingClientRect();
    if(r.bottom<-50||r.top>innerHeight+50) return;
    setClock(clamp((clamp(-r.top/(r.height-innerHeight))-.05)/.85));
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
    reveal(); tickClock(); tickStories();
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
