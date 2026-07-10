"use strict";

/* ---------- type + categories ---------- */
function setType(t){
  curType=t;
  document.getElementById("segExp").classList.toggle("sel",t==="exp");
  document.getElementById("segInc").classList.toggle("sel",t==="inc");
  document.getElementById("category").innerHTML=CATS[t].map(c=>`<option value="${c.n}">${c.e}  ${c.n}</option>`).join("");
}
function catE(type,name){return (CATS[type].find(c=>c.n===name)||{e:"💭"}).e;}

/* ---------- transactions ---------- */
function addTx(){
  const el=document.getElementById("amount");
  const amount=parseAmount(el.value);
  if(!amount||amount<=0){snack("Введите сумму больше нуля");el.focus();return;}
  state.tx.unshift({id:uid(),type:curType,amount,cat:document.getElementById("category").value,note:document.getElementById("note").value.trim(),date:new Date().toISOString()});
  save();
  el.value="";document.getElementById("note").value="";
  render();snack(curType==="inc"?"Доход добавлен":"Расход добавлен");el.focus();
}
function delTx(id){state.tx=state.tx.filter(t=>t.id!==id);save();render();}

function fmtDate(iso){
  const d=new Date(iso),now=new Date();
  const t=d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
  if(d.toDateString()===now.toDateString())return"Сегодня, "+t;
  const y=new Date(now);y.setDate(now.getDate()-1);
  if(d.toDateString()===y.toDateString())return"Вчера, "+t;
  return d.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})+", "+t;
}

/* ---------- render ---------- */
function render(){
  const inc=state.tx.filter(t=>t.type==="inc").reduce((s,t)=>s+t.amount,0);
  const exp=state.tx.filter(t=>t.type==="exp").reduce((s,t)=>s+t.amount,0);
  const balance=inc-exp;

  const series=monthlySeries(6);
  const cur=series[series.length-1],prev=series[series.length-2];
  const now=new Date();
  const monthStart=new Date(now.getFullYear(),now.getMonth(),1);
  const balBeforeThisMonth=state.tx.filter(t=>new Date(t.date)<monthStart)
    .reduce((s,t)=>s+(t.type==="inc"?t.amount:-t.amount),0);

  if(state.hideBalance){
    document.getElementById("balance").dataset.v=balance;
    document.getElementById("balance").textContent="• • • • • ₽";
    setDelta("balanceDelta",null,"Баланс скрыт");
  }else{
    animateNum("balance",balance);
    setDelta("balanceDelta",pctDelta(balance,balBeforeThisMonth),null,balance-balBeforeThisMonth);
  }
  const nwLine=document.getElementById("netWorthLine");
  if(state.assets.length||state.debts.length){
    const nw=balance+state.assets.reduce((s,a)=>s+a.amount,0)-state.debts.reduce((s,d)=>s+d.remaining,0);
    nwLine.textContent="Чистая стоимость (с активами и долгами): "+(state.hideBalance?"• • • • •":fmt(nw));
  }else{
    nwLine.textContent="";
  }
  animateNum("income",inc);animateNum("expense",exp);
  setDelta("incomeDelta",pctDelta(cur.inc,prev.inc),null,cur.inc-prev.inc);
  setDelta("expenseDelta",pctDelta(cur.exp,prev.exp),null,cur.exp-prev.exp,true);

  const debtRemain=state.debts.reduce((s,d)=>s+d.remaining,0);
  animateNum("debtTotal",debtRemain);
  document.getElementById("debtSub").textContent=state.debts.length?state.debts.length+" активных":"нет активных долгов";

  renderTxList();
  if(document.getElementById("fullHistoryScrim").classList.contains("show"))openFullHistory(); // держим диалог полной истории актуальным после правок
  renderSpark();
  renderGoals();renderAssets();renderFixed();renderDebts();renderCats();renderCatChanges();renderDynamics();
}

/* ---------- history: render + edit + search/filter ---------- */
let editTxId=null,txEditType="exp",histType="all";
/* применяет активные фильтры (поиск/категория/период/сумма/тип) к state.tx; используется и
   встроенным списком, и диалогом «вся история» — чтобы не дублировать логику фильтрации */
function filteredTx(){
  const search=(document.getElementById("histSearch")?.value||"").trim().toLowerCase();
  const cat=document.getElementById("histCat")?.value||"";
  const period=document.getElementById("histPeriod")?.value||"all";
  const min=parseAmount(document.getElementById("histMin")?.value);
  const max=parseAmount(document.getElementById("histMax")?.value);
  const now=new Date();
  const hasFilters=!!(search||cat||period!=="all"||!isNaN(min)||!isNaN(max)||histType!=="all");
  const rows=state.tx.filter(t=>{
    if(histType!=="all"&&t.type!==histType)return false;
    if(cat&&t.cat!==cat)return false;
    if(search&&!((t.note||"").toLowerCase().includes(search)||t.cat.toLowerCase().includes(search)))return false;
    if(!isNaN(min)&&t.amount<min)return false;
    if(!isNaN(max)&&t.amount>max)return false;
    if(period==="month"&&!sameMonth(t.date,now))return false;
    if(period==="prev"){const p=new Date(now.getFullYear(),now.getMonth()-1,1);if(!sameMonth(t.date,p))return false;}
    if(period==="30"&&new Date(t.date)<new Date(Date.now()-30*86400000))return false;
    return true;
  });
  return{rows,hasFilters};
}
function txRowHtml(t,i){
  return `<div class="list-item" style="animation-delay:${Math.min(i*.03,.5)}s" onclick="openTxEdit('${t.id}')" title="Изменить">
    <div class="avatar ${t.type}">${catE(t.type,t.cat)}</div>
    <div class="body"><b>${t.note?esc(t.note):esc(t.cat)}</b><span>${esc(t.cat)} · ${fmtDate(t.date)}</span></div>
    <div class="trail ${t.type}">${t.type==="inc"?"+":"−"}${fmt(t.amount)}</div>
    <button class="icon-btn del" onclick="event.stopPropagation();delTx('${t.id}')" title="Удалить" aria-label="Удалить">
      <svg class="icon sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>`;
}
function renderTxList(){
  const list=document.getElementById("txList");
  const{rows,hasFilters}=filteredTx();
  document.getElementById("txCount").textContent=state.tx.length?(hasFilters?rows.length+" из "+state.tx.length:rows.length+" всего"):"";
  if(!rows.length){
    list.innerHTML=state.tx.length
      ?empty("Ничего не найдено по этим фильтрам","M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.3-4.3")
      :empty("Пока нет операций. Добавьте первый доход или расход.","M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6");
    return;
  }
  list.innerHTML=rows.slice(0,60).map(txRowHtml).join("");
  if(rows.length>60){
    list.innerHTML+=`<div style="text-align:center;padding:10px"><button class="btn text" onclick="openFullHistory()">Показаны первые 60 из ${rows.length} — открыть всё</button></div>`;
  }
}
/* полный список по тем же фильтрам — открывается в отдельном диалоге, без обрезки списка */
function openFullHistory(){
  const{rows,hasFilters}=filteredTx();
  document.getElementById("fullHistoryDesc").textContent=hasFilters
    ?`${rows.length} из ${state.tx.length} операций — по текущим фильтрам`
    :`${rows.length} операций всего`;
  const box=document.getElementById("fullHistoryList");
  box.innerHTML=rows.length
    ?rows.slice(0,2000).map(txRowHtml).join("")
    :empty("Ничего не найдено","M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.3-4.3");
  openScrim("fullHistoryScrim");
}
function toggleHistFilters(){
  const box=document.getElementById("histFilters");
  const show=box.style.display==="none";
  box.style.display=show?"block":"none";
  if(show&&!box.dataset.init){
    const seen=new Set();const opts=['<option value="">Все категории</option>'];
    [...CATS.exp,...CATS.inc].forEach(c=>{if(!seen.has(c.n)){seen.add(c.n);opts.push(`<option value="${c.n}">${c.e}  ${c.n}</option>`);}});
    document.getElementById("histCat").innerHTML=opts.join("");
    box.dataset.init="1";
  }
}
function setHistType(t,el){
  histType=t;
  el.parentElement.querySelectorAll("button").forEach(b=>b.classList.remove("sel"));
  el.classList.add("sel");
  renderTxList();
}
function resetHistFilters(){
  document.getElementById("histSearch").value="";
  document.getElementById("histCat").value="";
  document.getElementById("histPeriod").value="all";
  document.getElementById("histMin").value="";
  document.getElementById("histMax").value="";
  histType="all";
  document.querySelectorAll("#histTypeSeg button").forEach((b,i)=>b.classList.toggle("sel",i===0));
  renderTxList();
}
function setTxEditType(t){
  txEditType=t;
  document.getElementById("txSegExp").classList.toggle("sel",t==="exp");
  document.getElementById("txSegInc").classList.toggle("sel",t==="inc");
  document.getElementById("txCategory").innerHTML=CATS[t].map(c=>`<option value="${c.n}">${c.e}  ${c.n}</option>`).join("");
}
function openTxEdit(id){
  const t=state.tx.find(x=>x.id===id);if(!t)return;
  editTxId=id;
  setTxEditType(t.type);
  document.getElementById("txAmount").value=t.amount;
  document.getElementById("txCategory").value=t.cat;
  document.getElementById("txNote").value=t.note||"";
  openScrim("txScrim");setTimeout(()=>document.getElementById("txAmount").focus(),90);
}
function saveTxEdit(){
  const t=state.tx.find(x=>x.id===editTxId);if(!t)return;
  const amount=parseAmount(document.getElementById("txAmount").value);
  if(!amount||amount<=0)return snack("Введите сумму больше нуля");
  t.type=txEditType;t.amount=amount;
  t.cat=document.getElementById("txCategory").value;
  t.note=document.getElementById("txNote").value.trim();
  save();closeScrim("txScrim");render();snack("Операция обновлена");
}
function delTxFromEdit(){
  if(!editTxId)return;
  if(confirm("Удалить эту операцию?")){delTx(editTxId);closeScrim("txScrim");}
}

/* дельта-строка (стрелка + % + абсолютная сумма) под большими цифрами */
function setDelta(id,pct,customText,absVal,invertColor){
  const el=document.getElementById(id);
  if(!el)return;
  if(customText){el.className="delta flat";el.textContent=customText;return;}
  if(pct===null||!isFinite(pct)){el.className="delta flat";el.textContent="нет данных за прошлый месяц";return;}
  const positive=pct>=0;
  const good=invertColor?!positive:positive; // для расходов рост — это "плохо" (красным)
  el.className="delta "+(pct===0?"flat":good?"up":"down");
  const arrow=pct===0?"":(positive?"↑ ":"↓ ");
  el.textContent=arrow+fmt(Math.abs(absVal))+" ("+Math.abs(pct)+"%)"+" за месяц";
}

let sparkPts=[]; // [{x,y,val,date}] в координатах viewBox, oldest -> newest
const SPARK_W=300,SPARK_H=60;
function renderSpark(){
  const svg=document.getElementById("spark"),wrap=document.getElementById("sparkWrap");
  const txs=[...state.tx].reverse(); // oldest -> newest
  if(txs.length<2){svg.style.display="none";wrap.onmousemove=wrap.onmouseleave=wrap.ontouchmove=wrap.ontouchend=null;sparkPts=[];return;}
  svg.style.display="block";
  let bal=0;const vals=[0],dates=[null];
  txs.forEach(t=>{bal+=t.type==="inc"?t.amount:-t.amount;vals.push(bal);dates.push(t.date);});
  const min=Math.min(...vals),max=Math.max(...vals),range=(max-min)||1,step=SPARK_W/(vals.length-1);
  sparkPts=vals.map((v,i)=>({x:i*step,y:SPARK_H-((v-min)/range)*(SPARK_H-10)-5,val:v,date:dates[i]}));
  const line=sparkPts.map((p,i)=>(i?"L":"M")+p.x.toFixed(1)+" "+p.y.toFixed(1)).join(" ");
  const area=line+` L ${SPARK_W} ${SPARK_H} L 0 ${SPARK_H} Z`;
  const last=sparkPts[sparkPts.length-1];
  svg.innerHTML=`<defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--spark)" stop-opacity=".28"/>
      <stop offset="1" stop-color="var(--spark)" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#sg)"/>
    <path d="${line}" fill="none" stroke="var(--spark)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" fill="var(--spark)" vector-effect="non-scaling-stroke"/>
    <line class="spark-dot-h" id="sparkHairline" x1="0" y1="0" x2="0" y2="${SPARK_H}" stroke="var(--spark)" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>
    <circle class="spark-dot-h" id="sparkHoverDot" r="4" fill="var(--spark)" vector-effect="non-scaling-stroke"/>`;
  wrap.onmousemove=e=>sparkHover(e.clientX);
  wrap.onmouseleave=sparkHoverEnd;
  wrap.ontouchmove=e=>{sparkHover(e.touches[0].clientX);e.preventDefault();};
  wrap.ontouchend=sparkHoverEnd;
}
function sparkHover(clientX){
  if(!sparkPts.length)return;
  const svg=document.getElementById("spark"),rect=svg.getBoundingClientRect();
  const step=SPARK_W/(sparkPts.length-1);
  let idx=Math.round((clientX-rect.left)/rect.width*SPARK_W/step);
  idx=Math.max(0,Math.min(sparkPts.length-1,idx));
  const p=sparkPts[idx];
  const hd=document.getElementById("sparkHoverDot"),hl=document.getElementById("sparkHairline");
  if(hd){hd.setAttribute("cx",p.x);hd.setAttribute("cy",p.y);hd.setAttribute("opacity",1);}
  if(hl){hl.setAttribute("x1",p.x);hl.setAttribute("x2",p.x);hl.setAttribute("opacity",1);}
  const tip=document.getElementById("sparkTip");
  tip.style.left=(p.x/SPARK_W*rect.width)+"px";
  tip.style.top=(p.y/SPARK_H*rect.height)+"px";
  tip.textContent=fmt(p.val)+(p.date?" · "+fmtDate(p.date):" · начало");
  tip.classList.add("show");
}
function sparkHoverEnd(){
  document.getElementById("sparkTip")?.classList.remove("show");
  const hd=document.getElementById("sparkHoverDot"),hl=document.getElementById("sparkHairline");
  if(hd)hd.setAttribute("opacity",0);
  if(hl)hl.setAttribute("opacity",0);
}

function empty(text,path){
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="${path}"/></svg><p>${text}</p></div>`;
}

/* ---------- goals ---------- */
function renderGoals(){
  const box=document.getElementById("goalList");
  if(!state.goals.length){box.innerHTML=empty("Создайте первую цель и копите с удовольствием","M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z");return;}
  box.innerHTML=state.goals.map(g=>{
    const pct=Math.min(100,Math.round(g.saved/g.target*100)),done=g.saved>=g.target,left=Math.max(0,g.target-g.saved);
    return `<div class="tile ${done?"done":""}">
      <div class="top"><div class="emoji">${g.emoji}</div>
        <div><div class="tname">${esc(g.name)}</div>
        <div class="tsub">${fmt(g.saved)} из ${fmt(g.target)}${done?" · Готово!":" · осталось "+fmt(left)}</div></div>
        <div class="pct">${pct}%</div></div>
      <div class="linear"><i data-w="${pct}"></i></div>
      <div class="acts">
        <button class="btn tonal" onclick="openAmt('goal','${g.id}')">Пополнить</button>
        <button class="btn text" onclick="openGoal('${g.id}')">Изменить</button>
        <button class="btn text danger" onclick="delGoal('${g.id}')" style="flex:0 0 44px;padding:0">
          <svg class="icon sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div></div>`;
  }).join("");
  fillBars(box);
}
function openGoal(id){
  editId=id||null;const g=id?state.goals.find(x=>x.id===id):null;
  document.getElementById("goalTitle").textContent=g?"Изменить цель":"Новая цель";
  document.getElementById("gName").value=g?g.name:"";
  document.getElementById("gTarget").value=g?g.target:"";
  document.getElementById("gSaved").value=g?g.saved:"";
  selEmoji=g?g.emoji:"🎯";
  renderEmojis("gEmoji",GOAL_EMOJIS);
  openScrim("goalScrim");setTimeout(()=>document.getElementById("gName").focus(),90);
}
function saveGoal(){
  const name=document.getElementById("gName").value.trim();
  const target=parseAmount(document.getElementById("gTarget").value);
  const saved=Math.max(0,parseAmount(document.getElementById("gSaved").value)||0);
  if(!name)return snack("Введите название цели");
  if(!target||target<=0)return snack("Введите нужную сумму");
  if(editId)Object.assign(state.goals.find(x=>x.id===editId),{name,target,saved,emoji:selEmoji});
  else state.goals.push({id:uid(),name,target,saved,emoji:selEmoji});
  save();closeScrim("goalScrim");render();snack("Цель сохранена");
}
function delGoal(id){if(confirm("Удалить эту цель?")){state.goals=state.goals.filter(g=>g.id!==id);save();render();}}

/* ---------- assets (savings, investments — не проходят через операции) ---------- */
let assetFilterType="all";
function toggleAssetFilters(){
  const box=document.getElementById("assetFilters");
  box.style.display=box.style.display==="none"?"block":"none";
}
function setAssetFilter(t,el){
  assetFilterType=t;
  el.parentElement.querySelectorAll("button").forEach(b=>b.classList.remove("sel"));
  el.classList.add("sel");
  renderAssets();
}
function renderAssets(){
  const box=document.getElementById("assetList");if(!box)return;
  if(!state.assets.length){box.innerHTML=empty("Добавьте сбережения, вклады, инвестиции — всё, что не проходит через операции.","M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2");return;}
  const search=(document.getElementById("assetSearch")?.value||"").trim().toLowerCase();
  const rows=state.assets.filter(a=>{
    if(assetFilterType==="manual"&&a.ticker)return false;
    if(assetFilterType==="moex"&&!a.ticker)return false;
    if(search&&!(a.name.toLowerCase().includes(search)||(a.ticker||"").toLowerCase().includes(search)))return false;
    return true;
  });
  // итог считаем по ВСЕМ активам (не по отфильтрованным) — чтобы совпадало с net worth
  const total=state.assets.reduce((s,a)=>s+a.amount,0);
  const sumline=`<div class="sumline"><span>Итого активов</span><span class="sv">${fmt(total)}</span></div>`;
  if(!rows.length){box.innerHTML=sumline+empty("Ничего не найдено по этим фильтрам","M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.3-4.3");return;}
  box.innerHTML=sumline+rows.map(a=>{
    const sub=a.ticker?`${a.qty} шт. × ${fmt(a.lastPrice||0)}`:"";
    return `<div class="mini-item" onclick="openAsset('${a.id}')" title="Изменить">
      <div class="mi-row">
        <div class="emoji">${a.emoji}</div>
        <div class="body"><b>${esc(a.name)}</b>${sub?`<span>${esc(sub)}</span>`:""}</div>
        <div class="amt">${fmt(a.amount)}</div>
      </div>
    </div>`;
  }).join("");
}
let assetKind="manual",lastFetchedPrice=null;
function setAssetKind(k,el){
  assetKind=k;
  if(el){el.parentElement.querySelectorAll("button").forEach(b=>b.classList.remove("sel"));el.classList.add("sel");}
  document.getElementById("assetNameBlock").style.display=k==="manual"?"block":"none";
  document.getElementById("assetManualBlock").style.display=k==="manual"?"block":"none";
  document.getElementById("assetMoexBlock").style.display=k==="moex"?"block":"none";
}
function openAsset(id){
  editId=id||null;const a=id?state.assets.find(x=>x.id===id):null;
  lastFetchedPrice=null;
  document.getElementById("assetTitle").textContent=a?"Изменить актив":"Новый актив";
  document.getElementById("aName").value=a?a.name:"";
  document.getElementById("aAmount").value=a&&!a.ticker?a.amount:"";
  document.getElementById("aTicker").value=a&&a.ticker?a.ticker:"";
  document.getElementById("aQty").value=a&&a.qty?a.qty:"";
  selEmoji=a?a.emoji:"💰";
  renderEmojis("aEmoji",ASSET_EMOJIS);
  document.getElementById("assetDelBtn").style.display=a?"":"none";
  const kind=a&&a.ticker?"moex":"manual";
  const btns=document.getElementById("assetKindSeg").querySelectorAll("button");
  setAssetKind(kind,kind==="moex"?btns[1]:btns[0]);
  document.getElementById("assetPriceInfo").textContent=
    a&&a.ticker&&a.lastPrice?`${fmt(a.lastPrice)} за шт. · обновлено ${fmtDate(a.priceUpdated)}`:"Курс ещё не загружен";
  openScrim("assetScrim");setTimeout(()=>document.getElementById("aName").focus(),90);
}
/* курс по тикеру MOEX через публичный ISS API (без ключа); бросает исключение, если не удалось */
/* определяет рынок инструмента на MOEX (акция/облигация/etc) по тикеру или ISIN */
async function resolveMoexGroup(ticker){
  const url=`https://iss.moex.com/iss/securities.json?q=${encodeURIComponent(ticker)}&iss.meta=off&securities.columns=secid,is_traded,group`;
  const r=await fetch(url);
  if(!r.ok)throw new Error("net");
  const j=await r.json();
  const cols=j.securities&&j.securities.columns,rows=j.securities&&j.securities.data;
  if(!cols||!rows)throw new Error("noresult");
  const secidIdx=cols.indexOf("secid"),tradedIdx=cols.indexOf("is_traded"),groupIdx=cols.indexOf("group");
  // ищем точное совпадение тикера/ISIN среди результатов поиска, предпочитая торгуемую бумагу
  const exact=rows.filter(row=>String(row[secidIdx]).toUpperCase()===ticker.toUpperCase());
  const row=exact.find(row=>row[tradedIdx]===1)||exact[0];
  if(!row)throw new Error("notfound");
  return row[groupIdx];
}
/* цена акции/фонда/расписки — LAST уже в рублях за штуку */
async function fetchMoexSharePrice(ticker){
  const url=`https://iss.moex.com/iss/engines/stock/markets/shares/securities/${encodeURIComponent(ticker)}.json?iss.meta=off&marketdata.columns=LAST,SECID`;
  const r=await fetch(url);
  if(!r.ok)throw new Error("net");
  const j=await r.json();
  const cols=j.marketdata&&j.marketdata.columns,rows=j.marketdata&&j.marketdata.data;
  const priceIdx=cols?cols.indexOf("LAST"):-1;
  // MOEX отдаёт по строке на каждую торговую площадку — берём первую с реальной ценой
  const row=priceIdx>=0&&rows?rows.find(r=>r[priceIdx]!=null):null;
  const price=row?row[priceIdx]:null;
  if(price==null)throw new Error("noprice");
  return price;
}
/* цена облигации — LAST у бумаг это % от номинала, а не рубли; плюс НКД (накопленный купонный доход) */
async function fetchMoexBondPrice(ticker){
  const url=`https://iss.moex.com/iss/engines/stock/markets/bonds/securities/${encodeURIComponent(ticker)}.json?iss.meta=off&securities.columns=SECID,FACEVALUE,ACCRUEDINT&marketdata.columns=SECID,LAST`;
  const r=await fetch(url);
  if(!r.ok)throw new Error("net");
  const j=await r.json();
  const scols=j.securities&&j.securities.columns,srows=j.securities&&j.securities.data;
  const mcols=j.marketdata&&j.marketdata.columns,mrows=j.marketdata&&j.marketdata.data;
  if(!scols||!srows||!srows.length)throw new Error("noresult");
  const faceIdx=scols.indexOf("FACEVALUE"),accIdx=scols.indexOf("ACCRUEDINT");
  const face=srows[0][faceIdx],acc=srows[0][accIdx]||0;
  const priceIdx=mcols?mcols.indexOf("LAST"):-1;
  const mrow=priceIdx>=0&&mrows?mrows.find(r=>r[priceIdx]!=null):null;
  const lastPct=mrow?mrow[priceIdx]:null;
  if(lastPct==null||face==null)throw new Error("noprice");
  return (lastPct/100)*face+acc; // «грязная» цена облигации в рублях за штуку (с учётом НКД)
}
/* универсальный вход: сам определяет акция это или облигация; при неясном исходе пробует оба рынка */
async function fetchMoexPrice(ticker){
  let group=null;
  try{group=await resolveMoexGroup(ticker);}catch(e){/* поиск не нашёл точного совпадения — попробуем оба рынка напрямую */}
  if(group==="stock_bonds"){
    try{return await fetchMoexBondPrice(ticker);}catch(e){return await fetchMoexSharePrice(ticker);}
  }
  try{return await fetchMoexSharePrice(ticker);}catch(e){return await fetchMoexBondPrice(ticker);}
}
/* обновляет курс в диалоге. silent=true — без snack-уведомлений (для авто-вызовов) */
async function refreshAssetPrice(silent){
  const ticker=document.getElementById("aTicker").value.trim().toUpperCase();
  if(!ticker){if(!silent)snack("Введите тикер");return false;}
  const info=document.getElementById("assetPriceInfo");
  info.textContent="Загрузка курса…";
  try{
    const price=await fetchMoexPrice(ticker);
    lastFetchedPrice={ticker,price,at:new Date().toISOString()};
    info.textContent=`${fmt(price)} за шт. · сейчас`;
    if(!silent)snack("Курс обновлён");
    return true;
  }catch(e){
    info.textContent="Не удалось получить курс — проверьте тикер или сеть";
    if(!silent)snack("Не удалось получить курс");
    return false;
  }
}
/* автозапрос курса, когда пользователь ушёл из поля тикера */
function onTickerBlur(){
  const ticker=document.getElementById("aTicker").value.trim().toUpperCase();
  if(!ticker)return;
  if(lastFetchedPrice&&lastFetchedPrice.ticker===ticker)return; // уже получали для этого тикера
  refreshAssetPrice(true);
}
async function saveAsset(){
  if(assetKind==="moex"){
    const ticker=document.getElementById("aTicker").value.trim().toUpperCase();
    const qty=parseAmount(document.getElementById("aQty").value);
    if(!ticker)return snack("Введите тикер");
    if(isNaN(qty)||qty<=0)return snack("Введите количество");
    const name=ticker; // отдельное название не спрашиваем — используем сам тикер
    const existing=editId?state.assets.find(x=>x.id===editId):null;
    let lastPrice=existing&&existing.ticker===ticker?existing.lastPrice:null;
    let priceUpdated=existing&&existing.ticker===ticker?existing.priceUpdated:null;
    if(lastFetchedPrice&&lastFetchedPrice.ticker===ticker){lastPrice=lastFetchedPrice.price;priceUpdated=lastFetchedPrice.at;}
    if(!lastPrice){
      // курс ещё не получали для этого тикера — пробуем прямо сейчас, без ручной кнопки
      const ok=await refreshAssetPrice(true);
      if(!ok)return snack("Не удалось получить курс — проверьте тикер");
      lastPrice=lastFetchedPrice.price;priceUpdated=lastFetchedPrice.at;
    }
    // уже есть актив с таким же тикером (кроме текущего редактируемого) — не дублируем, а суммируем количество
    const dup=state.assets.find(x=>x.ticker===ticker&&x.id!==editId);
    if(dup){
      dup.qty=(dup.qty||0)+qty;
      dup.lastPrice=lastPrice;dup.priceUpdated=priceUpdated;
      dup.amount=dup.qty*lastPrice;
      if(editId)state.assets=state.assets.filter(x=>x.id!==editId); // слили в dup, отдельную запись убираем
      save();closeScrim("assetScrim");render();
      snack(`Добавлено к «${dup.name}» — теперь ${dup.qty} шт.`);
      return;
    }
    const data={name,amount:qty*lastPrice,emoji:selEmoji,ticker,qty,lastPrice,priceUpdated};
    if(editId)Object.assign(state.assets.find(x=>x.id===editId),data);
    else state.assets.push({id:uid(),...data});
  }else{
    const name=document.getElementById("aName").value.trim();
    if(!name)return snack("Введите название");
    const amount=parseAmount(document.getElementById("aAmount").value);
    if(isNaN(amount)||amount<0)return snack("Введите сумму");
    const data={name,amount,emoji:selEmoji,ticker:null,qty:null,lastPrice:null,priceUpdated:null};
    if(editId)Object.assign(state.assets.find(x=>x.id===editId),data);
    else state.assets.push({id:uid(),...data});
  }
  save();closeScrim("assetScrim");render();snack("Актив сохранён");
}
function delAsset(){
  if(!editId)return;
  if(confirm("Удалить этот актив?")){state.assets=state.assets.filter(a=>a.id!==editId);save();closeScrim("assetScrim");render();snack("Актив удалён");}
}
/* фоновое обновление курсов всех тикерных активов: при загрузке и раз в час, пока страница активна */
let lastPricesRefresh=0;
const PRICE_REFRESH_INTERVAL=60*60*1000;
async function refreshAllAssetPrices(showToast){
  const withTicker=state.assets.filter(a=>a.ticker);
  lastPricesRefresh=Date.now();
  if(!withTicker.length)return;
  let changed=false;
  for(const a of withTicker){
    try{
      const price=await fetchMoexPrice(a.ticker);
      a.lastPrice=price;a.priceUpdated=new Date().toISOString();a.amount=a.qty*price;
      changed=true;
    }catch(e){/* тихо пропускаем — сеть могла быть недоступна, попробуем в следующий раз */}
  }
  if(changed){save();render();}
  if(showToast)snack("Курсы обновлены");
}
let assetPriceScheduled=false;
function scheduleAssetPriceRefresh(){
  refreshAllAssetPrices(false); // обновляем сразу при каждом вызове (в т.ч. повторный логин)
  if(assetPriceScheduled)return; // но таймер/слушатель регистрируем только один раз за жизнь страницы
  assetPriceScheduled=true;
  setInterval(()=>refreshAllAssetPrices(false),PRICE_REFRESH_INTERVAL);
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible"&&Date.now()-lastPricesRefresh>PRICE_REFRESH_INTERVAL)refreshAllAssetPrices(false);
  });
}

/* ---------- debts ---------- */
function computePdn(){
  const now=new Date();
  const monthlyPay=state.debts.reduce((s,d)=>s+(d.monthly||0),0);
  const monthInc=state.tx.filter(t=>t.type==="inc"&&sameMonth(t.date,now)).reduce((s,t)=>s+t.amount,0);
  const basis=state.monthlyIncome||monthInc;
  const pdn=basis>0?monthlyPay/basis*100:null;
  let verdict,vcol;
  if(pdn===null){verdict="Укажите доход, чтобы рассчитать показатель";vcol="var(--md-sys-color-on-surface-variant)";}
  else if(pdn<30){verdict="Низкая нагрузка — всё под контролем 👍";vcol="#2e7d32";}
  else if(pdn<50){verdict="Умеренная нагрузка — приемлемо";vcol="var(--md-warn)";}
  else if(pdn<80){verdict="Высокая нагрузка — будьте осторожны";vcol="#e07b00";}
  else{verdict="Критическая нагрузка — новые кредиты опасны";vcol="var(--md-sys-color-error)";}
  return {monthlyPay,monthInc,basis,pdn,verdict,vcol};
}
/* обновляет только показатели ПДН и аналитику, НЕ пересоздавая поле дохода —
   иначе каретка прыгала бы в начало на каждый введённый символ */
function updatePdn(){
  const big=document.getElementById("pdnBig");
  if(!big){render();return;}
  const p=computePdn();
  big.textContent=p.pdn===null?"—":Math.round(p.pdn)+"%";big.style.color=p.vcol;
  document.getElementById("pdnOf").textContent="платежей "+fmt(p.monthlyPay)+" / мес от дохода "+(p.basis?fmt(p.basis):"—");
  const v=document.getElementById("pdnVerdict");v.textContent=p.verdict;v.style.color=p.vcol;
  document.getElementById("pdnMarker").style.left=(p.pdn===null?0:Math.min(100,p.pdn))+"%";
  document.getElementById("pdnHint").textContent=state.monthlyIncome?"Учитывается указанный вами доход.":"Авто из доходов за месяц: "+fmt(p.monthInc)+".";
  renderDynamics();
}
function renderDebts(){
  const p=computePdn();
  const markerLeft=p.pdn===null?0:Math.min(100,p.pdn);
  document.getElementById("pdnBox").innerHTML=`<div class="pdn">
    <div class="pdn-head"><span class="big" id="pdnBig" style="color:${p.vcol}">${p.pdn===null?"—":Math.round(p.pdn)+"%"}</span>
      <span class="of" id="pdnOf">платежей ${fmt(p.monthlyPay)} / мес от дохода ${p.basis?fmt(p.basis):"—"}</span></div>
    <div class="verdict" id="pdnVerdict" style="color:${p.vcol}">${p.verdict}</div>
    <div class="zones"><div class="marker" id="pdnMarker" style="left:${markerLeft}%"></div></div>
    <div class="scale"><span>0%</span><span>30%</span><span>50%</span><span>80%</span><span>100%</span></div>
    <div class="field filled pdn-income">
      <input id="mIncome" type="number" placeholder=" " min="0" step="0.01" value="${state.monthlyIncome||""}" oninput="setIncome(this.value)">
      <label for="mIncome">Мой доход в месяц, ₽</label>
    </div>
    <div class="pdn-hint" id="pdnHint">${state.monthlyIncome?"Учитывается указанный вами доход.":"Авто из доходов за месяц: "+fmt(p.monthInc)+"."}</div>
  </div>`;

  const box=document.getElementById("debtList");
  if(!state.debts.length){box.innerHTML=empty("Долгов нет. Если есть кредит или рассрочка — добавьте, чтобы видеть нагрузку.","M4 4v16h16 M4 14l4-4 4 3 6-7");return;}
  box.innerHTML=state.debts.map(d=>{
    const paidPct=d.total>0?Math.min(100,Math.round((d.total-d.remaining)/d.total*100)):0;
    const done=d.remaining<=0;
    return `<div class="tile ${done?"done":""}">
      <div class="top"><div class="emoji">${d.emoji}</div>
        <div><div class="tname">${esc(d.name)}</div>
        <div class="tsub">${done?"Погашено! 🎉":"осталось "+fmt(d.remaining)+" · "+fmt(d.monthly||0)+"/мес"}</div></div>
        <div class="pct">${paidPct}%</div></div>
      <div class="linear"><i data-w="${paidPct}"></i></div>
      <div class="acts">
        <button class="btn tonal" onclick="openAmt('debt','${d.id}')" ${done?"disabled style=opacity:.5":""}>Внести платёж</button>
        <button class="btn text" onclick="openDebt('${d.id}')">Изменить</button>
        <button class="btn text danger" onclick="delDebt('${d.id}')" style="flex:0 0 44px;padding:0">
          <svg class="icon sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div></div>`;
  }).join("");
  fillBars(box);
}
function setIncome(v){
  state.monthlyIncome=v?Math.max(0,parseAmount(v)):null;
  save();
  updatePdn(); // патчим показатели; поле дохода не пересоздаётся → каретка остаётся на месте
}
function openDebt(id){
  editId=id||null;const d=id?state.debts.find(x=>x.id===id):null;
  document.getElementById("debtTitle").textContent=d?"Изменить долг":"Новый долг";
  document.getElementById("dName").value=d?d.name:"";
  document.getElementById("dTotal").value=d?d.total:"";
  document.getElementById("dRemain").value=d?d.remaining:"";
  document.getElementById("dMonthly").value=d?(d.monthly||""):"";
  selEmoji=d?d.emoji:"🏦";
  renderEmojis("dEmoji",DEBT_EMOJIS);
  openScrim("debtScrim");setTimeout(()=>document.getElementById("dName").focus(),90);
}
function saveDebt(){
  const name=document.getElementById("dName").value.trim();
  const total=parseAmount(document.getElementById("dTotal").value);
  let remaining=parseAmount(document.getElementById("dRemain").value);
  const monthly=Math.max(0,parseAmount(document.getElementById("dMonthly").value)||0);
  if(!name)return snack("Введите название долга");
  if(!total||total<=0)return snack("Введите общую сумму долга");
  if(isNaN(remaining))remaining=total;
  remaining=Math.max(0,remaining);
  if(editId)Object.assign(state.debts.find(x=>x.id===editId),{name,total,remaining,monthly,emoji:selEmoji});
  else state.debts.push({id:uid(),name,total,remaining,monthly,emoji:selEmoji});
  save();closeScrim("debtScrim");render();snack("Долг сохранён");
}
function delDebt(id){if(confirm("Удалить этот долг?")){state.debts=state.debts.filter(d=>d.id!==id);save();render();}}

/* ---------- amount dialog (goal deposit / debt payment) ---------- */
function openAmt(mode,id){
  amtMode=mode;amtId=id;
  if(mode==="goal"){
    const g=state.goals.find(x=>x.id===id);
    document.getElementById("amtTitle").textContent="Пополнить цель";
    document.getElementById("amtDesc").textContent=g.emoji+" "+g.name+" — "+fmt(g.saved)+" из "+fmt(g.target);
    document.getElementById("amtLabel").textContent="Сумма (можно −, чтобы снять)";
  }else{
    const d=state.debts.find(x=>x.id===id);
    document.getElementById("amtTitle").textContent="Внести платёж";
    document.getElementById("amtDesc").textContent=d.emoji+" "+d.name+" — осталось "+fmt(d.remaining);
    document.getElementById("amtLabel").textContent="Сумма платежа, ₽";
  }
  document.getElementById("amtValue").value="";
  openScrim("amtScrim");setTimeout(()=>document.getElementById("amtValue").focus(),90);
}
function confirmAmt(){
  const v=parseAmount(document.getElementById("amtValue").value);
  if(!v)return snack("Введите сумму");
  if(amtMode==="goal"){
    const g=state.goals.find(x=>x.id===amtId);const was=g.saved>=g.target;
    g.saved=Math.max(0,g.saved+v);save();closeScrim("amtScrim");render();
    if(!was&&g.saved>=g.target){celebrate();snack("Цель достигнута! 🎉");}else snack(v>0?"Цель пополнена":"Сумма снята");
  }else{
    const d=state.debts.find(x=>x.id===amtId);const was=d.remaining<=0;
    d.remaining=Math.max(0,d.remaining-Math.abs(v));save();closeScrim("amtScrim");render();
    if(!was&&d.remaining<=0){celebrate();snack("Долг погашен! 🎉");}else snack("Платёж внесён");
  }
}

/* ---------- categories breakdown ---------- */
/* ---------- category analytics: flexible period ---------- */
let catsPeriod="month";
const CATS_PERIOD_LABEL={month:"за месяц",prev:"за прошл. мес.",["3m"]:"за 3 месяца",year:"за год",all:"за всё время",custom:"за период"};
function catsRange(){
  const now=new Date();
  switch(catsPeriod){
    case "prev":return{from:new Date(now.getFullYear(),now.getMonth()-1,1),to:new Date(now.getFullYear(),now.getMonth(),1)};
    case "3m":return{from:new Date(now.getFullYear(),now.getMonth()-2,1),to:new Date(now.getFullYear(),now.getMonth()+1,1)};
    case "year":return{from:new Date(now.getFullYear(),0,1),to:new Date(now.getFullYear()+1,0,1)};
    case "all":return{from:new Date(0),to:new Date(now.getFullYear()+1,0,1)};
    case "custom":{
      const fEl=document.getElementById("catsFrom"),tEl=document.getElementById("catsTo");
      const from=fEl&&fEl.value?new Date(fEl.value+"T00:00:00"):new Date(0);
      const to=tEl&&tEl.value?new Date(new Date(tEl.value+"T00:00:00").getTime()+86400000):new Date();
      return{from,to};
    }
    default:return{from:new Date(now.getFullYear(),now.getMonth(),1),to:new Date(now.getFullYear(),now.getMonth()+1,1)};
  }
}
/* период той же длины, что и текущий, но непосредственно перед ним — для сравнения категорий */
function catsPrevRange(){
  const{from,to}=catsRange();
  const span=to-from;
  return{from:new Date(from.getTime()-span),to:new Date(from.getTime())};
}
function onCatsPeriodChange(){
  catsPeriod=document.getElementById("catsPeriodSel").value;
  const box=document.getElementById("catsCustomRange");
  box.style.display=catsPeriod==="custom"?"flex":"none";
  if(catsPeriod==="custom"){
    const fEl=document.getElementById("catsFrom"),tEl=document.getElementById("catsTo");
    if(!fEl.value){const d=new Date();d.setMonth(d.getMonth()-1);fEl.value=d.toISOString().slice(0,10);}
    if(!tEl.value)tEl.value=new Date().toISOString().slice(0,10);
  }
  renderCats();renderCatChanges();
}
function sumByCat(from,to){
  const by={};
  state.tx.forEach(t=>{
    if(t.type!=="exp")return;
    const d=new Date(t.date);
    if(d>=from&&d<to)by[t.cat]=(by[t.cat]||0)+t.amount;
  });
  return by;
}
function renderCats(){
  const box=document.getElementById("catList");
  const{from,to}=catsRange();
  const by=sumByCat(from,to);
  let rows=Object.entries(by).sort((a,b)=>b[1]-a[1]);
  const total=rows.reduce((s,r)=>s+r[1],0);
  if(!rows.length){box.innerHTML=empty("За выбранный период расходов пока нет","M3 3v18h18 M7 14l4-4 3 3 5-6");return;}
  // group tail into "Другое" for a readable donut
  if(rows.length>7){const rest=rows.slice(6).reduce((s,r)=>s+r[1],0);rows=rows.slice(0,6);rows.push(["Другое",rest]);}

  const R=68,CX=86,CY=86,C=2*Math.PI*R,GAP=total?Math.min(C*0.006,3):0;
  let off=0;
  const segs=rows.map(([name,val],i)=>{
    const len=Math.max(0,(val/total)*C-GAP);
    const s=`<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${CAT_COLORS[i%CAT_COLORS.length]}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off+=(val/total)*C;return s;
  }).join("");
  const legend=rows.map(([name,val],i)=>{
    const pct=Math.round(val/total*100);
    return `<div class="lg"><span class="sw" style="background:${CAT_COLORS[i%CAT_COLORS.length]}"></span>
      <span class="ln">${catE("exp",name)} ${esc(name)}</span>
      <span class="lv">${fmt(val)}</span><span class="lp">${pct}%</span></div>`;
  }).join("");
  box.innerHTML=`<div class="donut-wrap">
    <div class="donut">
      <svg viewBox="0 0 172 172">${segs}</svg>
      <div class="center"><span class="t1">${CATS_PERIOD_LABEL[catsPeriod]||"за период"}</span><span class="t2">${fmt(total)}</span></div>
    </div>
    <div class="legend">${legend}</div>
  </div>`;
}
/* заметные изменения категорий относительно предыдущего периода той же длины */
function renderCatChanges(){
  const box=document.getElementById("catChanges");if(!box)return;
  if(catsPeriod==="all"){box.innerHTML="";return;}
  const{from,to}=catsRange();
  const prev=catsPrevRange();
  const curBy=sumByCat(from,to),prevBy=sumByCat(prev.from,prev.to);
  const cats=new Set([...Object.keys(curBy),...Object.keys(prevBy)]);
  let rows=[...cats].map(cat=>({cat,cur:curBy[cat]||0,pv:prevBy[cat]||0,d:pctDelta(curBy[cat]||0,prevBy[cat]||0)}))
    .filter(r=>r.d!==null&&r.d!==0);
  rows.sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));
  rows=rows.slice(0,4);
  if(!rows.length){box.innerHTML="";return;}
  box.innerHTML=`<div class="sub-head" style="margin-top:16px"><span>Заметные изменения к прошлому периоду</span></div>`+
    rows.map(r=>{
      const up=r.d>0;
      return `<div class="fi-line" style="padding:4px 2px">
        <span>${catE("exp",r.cat)} ${esc(r.cat)}</span>
        <b style="color:${up?"var(--md-sys-color-error)":"var(--md-sys-color-primary)"}">${up?"↑":"↓"} ${Math.abs(r.d)}%</b>
      </div>`;
    }).join("");
}

/* ---------- mandatory (fixed) expenses ---------- */
function renderFixed(){
  const now=new Date();
  const total=state.fixed.reduce((s,f)=>s+f.amount,0);
  document.getElementById("fixedTotalLbl").textContent=fmt(total)+" / мес";
  const box=document.getElementById("fixedList");
  if(!state.fixed.length){box.innerHTML=empty("Добавьте обязательные ежемесячные платежи: аренда, ЖКХ, связь, подписки.","M3 9h18 M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z");return;}
  box.innerHTML=[...state.fixed].sort((a,b)=>b.amount-a.amount).map(f=>{
    let sub=f.days&&f.days.length?("каждое "+f.days.join("-е, ")+"-е число"):"ежемесячно";
    let prog="";
    if(f.category){
      const spent=monthCatSpent(f.category,now);
      const pct=f.amount>0?Math.min(100,Math.round(spent/f.amount*100)):0;
      const over=spent>f.amount;
      sub=f.category;
      prog=`<div class="mi-prog">
        <div class="linear" style="height:5px"><i data-w="${pct}"${over?' style="background:var(--md-sys-color-error)"':''}></i></div>
        <span class="fpay">${fmt(spent)} из ${fmt(f.amount)} за месяц${spent>=f.amount?" ✓":""}</span></div>`;
    }
    return `<div class="mini-item" onclick="openFixInfo('${f.id}')" title="Подробнее">
      <div class="mi-row">
        <div class="emoji">${f.emoji}</div>
        <div class="body"><b>${esc(f.name)}</b><span>${esc(sub)}</span></div>
        <div class="amt">${fmt(f.amount)}</div>
      </div>${prog}</div>`;
  }).join("");
  fillBars(box);
}
/* иконки для обязательного платежа: базовый набор + иконки всех категорий расходов */
let fixedEmojiAuto=true; // пока true — смена категории сама подставляет её иконку (только для новых платежей)
function fixedEmojiChoices(category){
  // базовый набор + иконки ВСЕХ категорий расходов — доступны сразу, не только у выбранной
  const list=[...new Set([...FIX_EMOJIS,...CATS.exp.map(c=>c.e)])];
  if(selEmoji&&!list.includes(selEmoji))list.unshift(selEmoji);
  return list;
}
function onFixedCategoryChange(){
  const cat=document.getElementById("fCategory").value;
  if(fixedEmojiAuto)selEmoji=cat?catE("exp",cat):"🏠";
  renderEmojis("fEmoji",fixedEmojiChoices(cat));
}
function openFixed(id){
  editId=id||null;const f=id?state.fixed.find(x=>x.id===id):null;
  document.getElementById("fixedTitle").textContent=f?"Изменить платёж":"Обязательный платёж";
  document.getElementById("fName").value=f?f.name:"";
  document.getElementById("fAmount").value=f?f.amount:"";
  document.getElementById("fDays").value=f&&f.days&&f.days.length?f.days.join(", "):"";
  document.getElementById("fCategory").innerHTML='<option value="">— без привязки —</option>'+CATS.exp.map(c=>`<option value="${c.n}">${c.e}  ${c.n}</option>`).join("");
  const cat=f?(f.category||""):"";
  document.getElementById("fCategory").value=cat;
  selEmoji=f?f.emoji:(cat?catE("exp",cat):"🏠");
  fixedEmojiAuto=!f; // для новых платежей категория подсказывает иконку, для существующих — не трогаем сохранённую
  renderEmojis("fEmoji",fixedEmojiChoices(cat));
  openScrim("fixedScrim");setTimeout(()=>document.getElementById("fName").focus(),90);
}
function saveFixed(){
  const name=document.getElementById("fName").value.trim();
  const amount=parseAmount(document.getElementById("fAmount").value);
  const daysRaw=document.getElementById("fDays").value.trim();
  const days=daysRaw
    ?[...new Set(daysRaw.split(",").map(s=>parseInt(s.trim(),10)).filter(d=>d>=1&&d<=31))].sort((a,b)=>a-b)
    :[];
  const category=document.getElementById("fCategory").value||null;
  if(!name)return snack("Введите название");
  if(!amount||amount<=0)return snack("Введите сумму");
  if(editId)Object.assign(state.fixed.find(x=>x.id===editId),{name,amount,days,category,emoji:selEmoji});
  else state.fixed.push({id:uid(),name,amount,days,category,emoji:selEmoji});
  save();closeScrim("fixedScrim");render();snack("Платёж сохранён");
}
function delFixed(id){if(confirm("Удалить этот платёж?")){state.fixed=state.fixed.filter(f=>f.id!==id);save();render();}}

/* сколько потрачено по категории в этом месяце (факт) */
function monthCatSpent(cat,now){
  return state.tx.filter(t=>t.type==="exp"&&t.cat===cat&&sameMonth(t.date,now)).reduce((s,t)=>s+t.amount,0);
}

/* карточка-детали обязательного платежа (по клику) */
let infoFixedId=null;
function openFixInfo(id){
  infoFixedId=id;
  const f=state.fixed.find(x=>x.id===id);if(!f)return;
  const now=new Date();
  document.getElementById("fiTitle").textContent=f.emoji+"  "+f.name;
  const bits=["План: "+fmt(f.amount)+" / мес"];
  if(f.days&&f.days.length)bits.push("оплата "+f.days.join("-го, ")+"-го числа"+(f.days.length>1?" · по "+fmt(f.amount/f.days.length):""));
  document.getElementById("fiDesc").textContent=bits.join(" · ");
  let body="";
  if(f.category){
    const spent=monthCatSpent(f.category,now);
    const pct=f.amount>0?Math.min(100,Math.round(spent/f.amount*100)):0;
    const over=spent-f.amount;
    body+=`<div class="linear" style="height:8px;margin:4px 0 12px"><i style="width:${pct}%${spent>f.amount?";background:var(--md-sys-color-error)":""}"></i></div>
      <div class="fi-line"><span>Потрачено в этом месяце</span><b>${fmt(spent)}</b></div>
      <div class="fi-line muted"><span>Категория «${esc(f.category)}»</span><span>${over>=0?"сверх плана "+fmt(over):"остаток "+fmt(-over)}</span></div>`;
    const list=state.tx.filter(t=>t.type==="exp"&&t.cat===f.category&&sameMonth(t.date,now));
    if(list.length){
      body+=`<div class="fi-sub">Операции за месяц (${list.length}):</div>`;
      body+=list.slice(0,10).map(t=>`<div class="fi-line"><span>${esc(t.note||t.cat)} · ${fmtDate(t.date)}</span><b>${fmt(t.amount)}</b></div>`).join("");
    }else{
      body+=`<div class="fi-sub">В этом месяце операций в этой категории ещё не было.</div>`;
    }
  }else{
    body=`<div class="fi-sub">Категория не привязана. Привяжите её в «Изменить» — тогда операции с этой категорией будут учитываться здесь за текущий месяц.</div>`;
  }
  document.getElementById("fiBody").innerHTML=body;
  openScrim("fixInfoScrim");
}
function editFixedFromInfo(){const id=infoFixedId;closeScrim("fixInfoScrim");openFixed(id);}
function delFixedFromInfo(){const id=infoFixedId;if(confirm("Удалить этот платёж?")){state.fixed=state.fixed.filter(f=>f.id!==id);save();closeScrim("fixInfoScrim");render();snack("Платёж удалён");}}

/* ---------- auto-tracking due fixed payments (поддержка нескольких дат в месяце) ---------- */
function monthKey(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");}
function dueFixedPayments(){
  const now=new Date(),mk=monthKey(now),today=now.getDate();
  const due=[];
  state.fixed.forEach(f=>{
    const days=f.days||[];
    if(!days.length)return; // без дат платежа автосписание не отслеживаем
    const perOcc=f.amount/days.length;
    // сколько раз в этом месяце уже проведена операция по этому платежу — считаем это подтверждёнными occurrence-ами по порядку
    const loggedCount=state.tx.filter(t=>t.fixedId===f.id&&sameMonth(t.date,now)).length;
    days.forEach((d,idx)=>{
      if(d>today)return; // день ещё не наступил
      if(idx<loggedCount)return; // это вхождение уже оплачено
      if(state.fixedSkips.includes(f.id+":"+mk+":"+d))return; // пользователь пропустил именно эту дату
      due.push({fixed:f,day:d,amount:perOcc,idx});
    });
  });
  return due;
}
function checkDuePayments(){
  const due=dueFixedPayments();
  if(!due.length)return;
  document.getElementById("dueBody").innerHTML=due.map(item=>{
    const f=item.fixed,rowId=f.id+"-"+item.day;
    const occLabel=f.days.length>1?` · платёж ${item.idx+1} из ${f.days.length}`:"";
    return `
    <div class="tile" data-fid="${rowId}" style="margin-bottom:10px">
      <div class="top">
        <div class="emoji">${f.emoji}</div>
        <div><div class="tname">${esc(f.name)}</div><div class="tsub">${f.category?esc(f.category):"без категории"} · ${item.day}-е число${occLabel}</div></div>
      </div>
      <div class="field" style="margin-top:8px"><input type="number" step="0.01" placeholder=" " value="${item.amount}" id="due-amt-${rowId}"><label for="due-amt-${rowId}">Сумма, ₽</label></div>
      <div class="acts">
        <button class="btn tonal" onclick="confirmDuePayment('${f.id}','${rowId}')">Подтвердить</button>
        <button class="btn text" onclick="skipDuePayment('${f.id}','${item.day}','${rowId}')">Пропустить</button>
      </div>
    </div>`;
  }).join("");
  openScrim("dueScrim");
}
function confirmDuePayment(fid,rowId){
  const f=state.fixed.find(x=>x.id===fid);if(!f)return;
  const amount=parseAmount(document.getElementById("due-amt-"+rowId).value);
  if(!amount||amount<=0)return snack("Введите сумму");
  state.tx.unshift({id:uid(),type:"exp",amount,cat:f.category||"Другое",note:f.name,date:new Date().toISOString(),fixedId:f.id});
  save();removeDueRow(rowId);render();snack("Платёж добавлен в историю");
}
function skipDuePayment(fid,day,rowId){
  state.fixedSkips.push(fid+":"+monthKey(new Date())+":"+day);
  save();removeDueRow(rowId);snack("Пропущено в этом месяце");
}
function removeDueRow(rowId){
  const el=document.querySelector(`#dueBody [data-fid="${rowId}"]`);
  if(el)el.remove();
  if(!document.getElementById("dueBody").children.length)closeScrim("dueScrim");
}

/* ---------- dynamics (metrics + line chart) ---------- */
let dynTab="exp";
function setDynTab(t){dynTab=t;renderDynamics();}
function renderDynamics(){
  const now=new Date();
  const data=monthlySeries(6);
  const cur=data[5],prev=data[4];
  const basis=state.monthlyIncome||cur.inc;
  const oblig=state.fixed.reduce((s,f)=>s+f.amount,0)+state.debts.reduce((s,d)=>s+(d.monthly||0),0);
  const free=basis-oblig;
  const savRate=basis>0?Math.round((basis-cur.exp)/basis*100):null;
  const dayN=now.getDate(),dim=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const forecast=dayN>0?cur.exp/dayN*dim:0;
  const dExp=pctDelta(cur.exp,prev.exp);
  const P="var(--md-sys-color-primary)",E="var(--md-sys-color-error)",W="var(--md-warn)";

  // «хватит денег на N дней»: текущий баланс / средний дневной расход за последние 30 дней
  const balance=state.tx.reduce((s,t)=>s+(t.type==="inc"?t.amount:-t.amount),0);
  const from30=new Date(now.getTime()-30*86400000);
  const exp30=state.tx.filter(t=>t.type==="exp"&&new Date(t.date)>=from30).reduce((s,t)=>s+t.amount,0);
  const dailyRate=exp30/30;
  let runwayVal,runwayCol,runwayHint;
  if(balance<=0){runwayVal="0 дней";runwayCol=E;runwayHint="баланс уже в нуле или минусе";}
  else if(dailyRate<=0){runwayVal="∞";runwayCol=P;runwayHint="нет расходов за 30 дней";}
  else{
    const days=Math.floor(balance/dailyRate);
    runwayVal=days+" "+ruDays(days);
    runwayCol=days<14?E:days<45?W:P;
    runwayHint="при темпе "+fmt(dailyRate)+"/день";
  }

  const metrics=`<div class="metrics">
    <div class="metric"><div class="ml">Свободно в месяц</div>
      <div class="mv" style="color:${free>=0?P:E}">${fmt(free)}</div>
      <div class="mh">доход − обязательные − долги</div></div>
    <div class="metric"><div class="ml">Норма сбережений</div>
      <div class="mv">${savRate===null?"—":savRate+"%"}</div>
      <div class="mh">отложено от дохода за месяц</div></div>
    <div class="metric"><div class="ml">Прогноз расходов</div>
      <div class="mv">${fmt(forecast)}</div>
      <div class="mh">к концу месяца при текущем темпе</div></div>
    <div class="metric"><div class="ml">Расходы к прошлому мес.</div>
      <div class="mv" style="color:${dExp===null?"inherit":(dExp>0?E:P)}">${dExp===null?"—":(dExp>0?"+":"")+dExp+"%"}</div>
      <div class="mh">${fmt(cur.exp)} против ${fmt(prev.exp)}</div></div>
    <div class="metric"><div class="ml">Хватит денег на</div>
      <div class="mv" style="color:${runwayCol}">${runwayVal}</div>
      <div class="mh">${runwayHint}</div></div>
  </div>`;

  const toggle=`<div class="mini-seg">
    <button class="${dynTab==="exp"?"sel":""}" onclick="setDynTab('exp')">Расходы</button>
    <button class="${dynTab==="inc"?"sel":""}" onclick="setDynTab('inc')">Доходы</button>
  </div>`;

  document.getElementById("dynamics").innerHTML=metrics+toggle+
    `<svg class="dyn-chart" id="dynChart" viewBox="0 0 520 150" preserveAspectRatio="none"></svg>
    <div class="dyn-labels">${data.map((x,i)=>`<span class="${i===5?"cur":""}">${x.md.toLocaleDateString("ru-RU",{month:"short"}).replace(".","")}</span>`).join("")}</div>`;

  drawDynChart(data);
}
function smoothPath(pts){
  if(pts.length<2)return pts.length?`M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`:"";
  let d=`M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for(let i=0;i<pts.length-1;i++){
    const [x0,y0]=pts[i],[x1,y1]=pts[i+1],cx=(x0+x1)/2;
    d+=` C ${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
function drawDynChart(data){
  const svg=document.getElementById("dynChart");if(!svg)return;
  const vals=data.map(x=>x[dynTab]);
  const w=520,h=150,pad=12;
  const max=Math.max(1,...vals),step=vals.length>1?w/(vals.length-1):w;
  const pts=vals.map((v,i)=>[i*step,h-pad-(v/max)*(h-pad*2)]);
  const line=smoothPath(pts);
  const area=line+` L ${w} ${h} L 0 ${h} Z`;
  const col=dynTab==="inc"?"var(--md-sys-color-primary)":"var(--md-sys-color-error)";
  const dots=pts.map((p,i)=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${col}" vector-effect="non-scaling-stroke"><title>${fmt(vals[i])}</title></circle>`).join("");
  svg.innerHTML=`<defs><linearGradient id="dg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity=".25"/>
      <stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#dg)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}`;
}

/* ---------- helpers ---------- */
function sameMonth(iso,now){const d=new Date(iso);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}
/* сумма доходов/расходов по месяцам за последние n месяцев (включая текущий, последний в массиве) */
function monthlySeries(n){
  const now=new Date();
  const arr=[];
  for(let i=n-1;i>=0;i--){
    const md=new Date(now.getFullYear(),now.getMonth()-i,1);
    let inc=0,exp=0;
    state.tx.forEach(t=>{
      const d=new Date(t.date);
      if(d.getFullYear()===md.getFullYear()&&d.getMonth()===md.getMonth()){
        if(t.type==="inc")inc+=t.amount;else exp+=t.amount;
      }
    });
    arr.push({md,inc,exp});
  }
  return arr;
}
/* процент изменения cur относительно prev; null, если prev==0 (не с чем сравнивать) */
function pctDelta(cur,prev){
  if(prev===0)return cur===0?0:null;
  return Math.round((cur-prev)/Math.abs(prev)*100);
}
/* склонение "день/дня/дней" по числу */
function ruDays(n){
  n=Math.abs(n)%100;
  const n1=n%10;
  if(n>10&&n<20)return"дней";
  if(n1>1&&n1<5)return"дня";
  if(n1===1)return"день";
  return"дней";
}
function fillBars(scope){requestAnimationFrame(()=>scope.querySelectorAll(".linear i").forEach(el=>el.style.width=el.dataset.w+"%"));}
function renderEmojis(boxId,arr){
  document.getElementById(boxId).innerHTML=arr.map(e=>`<button class="${e===selEmoji?"sel":""}" onclick="pickEmoji('${e}',this)">${e}</button>`).join("");
}
function pickEmoji(e,el){selEmoji=e;fixedEmojiAuto=false;el.parentElement.querySelectorAll("button").forEach(b=>b.classList.remove("sel"));el.classList.add("sel");}

function openScrim(id){document.getElementById(id).classList.add("show");}
function closeScrim(id){document.getElementById(id).classList.remove("show");}

function animateNum(id,to){
  const el=document.getElementById(id),from=parseFloat(el.dataset.v||"0");
  el.dataset.v=to;const dur=600,start=performance.now();
  (function step(now){const p=Math.min(1,(now-start)/dur),e=1-Math.pow(1-p,3);
    const cur=from+(to-from)*e;
    el.textContent=fmt(p<1?Math.round(cur):to);if(p<1)requestAnimationFrame(step);})(start);
}

let snackT;
function snack(msg){
  const s=document.getElementById("snack");s.textContent=msg;s.classList.add("show");
  clearTimeout(snackT);snackT=setTimeout(()=>s.classList.remove("show"),2400);
}
function celebrate(){
  const cols=["#006d45","#5fe1a1","#3d6373","#c8a200","#e07b00","#ba1a1a"];
  for(let i=0;i<70;i++){const c=document.createElement("div");c.className="confetti";
    c.style.left=Math.random()*100+"vw";c.style.top="-20px";c.style.background=cols[i%cols.length];
    c.style.transform=`rotate(${Math.random()*360}deg)`;
    c.style.animation=`fall ${1.5+Math.random()*1.5}s ${Math.random()*.4}s linear forwards`;
    if(Math.random()>.5)c.style.borderRadius="50%";
    document.body.appendChild(c);setTimeout(()=>c.remove(),3500);}
}

/* ---------- theme ---------- */
const moonIcon=`<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const sunIcon=`<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>`;
function applyTheme(){
  document.documentElement.setAttribute("data-theme",state.theme);
  document.getElementById("themeBtn").innerHTML=state.theme==="dark"?sunIcon:moonIcon;
}
document.getElementById("themeBtn").onclick=()=>{state.theme=state.theme==="dark"?"light":"dark";save();applyTheme();};

/* ---------- hide balance ---------- */
const eyeIcon=`<svg class="icon sm" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOffIcon=`<svg class="icon sm" viewBox="0 0 24 24"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a20.32 20.32 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
function applyHideBalanceIcon(){
  document.getElementById("hideBalBtn").innerHTML=state.hideBalance?eyeOffIcon:eyeIcon;
}
document.getElementById("hideBalBtn").onclick=()=>{
  state.hideBalance=!state.hideBalance;save();applyHideBalanceIcon();render();
};

/* ---------- export / import / reset ---------- */
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  const d=new Date();a.download=`финансы-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}.json`;
  a.click();snack("Копия сохранена в файл");
}
function importData(ev){
  const f=ev.target.files[0];if(!f)return;const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);if(!Array.isArray(d.tx))throw 0;
    const th=state.theme;state=normalize(d);state.theme=d.theme||th;
    save();applyTheme();render();snack("Данные загружены");}
    catch(e){snack("Не удалось прочитать файл");}};
  r.readAsText(f);ev.target.value="";
}
function resetAll(){
  if(!confirm("Удалить ВСЕ операции, цели, долги и обязательные платежи? Это нельзя отменить."))return;
  const th=state.theme;state=normalize({});state.theme=th;save();render();snack("Всё очищено");
}

/* ---------- events ---------- */
["amount","note"].forEach(id=>document.getElementById(id).addEventListener("keydown",e=>{if(e.key==="Enter")addTx();}));
document.getElementById("amtValue").addEventListener("keydown",e=>{if(e.key==="Enter")confirmAmt();});
["fAmount","fDays"].forEach(id=>document.getElementById(id).addEventListener("keydown",e=>{if(e.key==="Enter")saveFixed();}));
["txAmount","txNote"].forEach(id=>document.getElementById(id).addEventListener("keydown",e=>{if(e.key==="Enter")saveTxEdit();}));
document.getElementById("aAmount").addEventListener("keydown",e=>{if(e.key==="Enter")saveAsset();});
document.getElementById("histSearch").addEventListener("keydown",e=>{if(e.key==="Enter")e.preventDefault();});
["liUser","liPass"].forEach(id=>document.getElementById(id).addEventListener("keydown",e=>{if(e.key==="Enter")doLogin();}));
document.getElementById("logoutBtn").onclick=logout;
["goalScrim","debtScrim","amtScrim","fixedScrim","fixInfoScrim","txScrim","dueScrim","assetScrim","fullHistoryScrim"].forEach(id=>document.getElementById(id).addEventListener("click",e=>{if(e.target.id===id)closeScrim(id);}));
document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelectorAll(".scrim.show").forEach(s=>s.classList.remove("show"));});
window.addEventListener("scroll",()=>document.getElementById("appbar").classList.toggle("scrolled",window.scrollY>4));

/* ---------- init ---------- */
applyTheme();applyHideBalanceIcon();setType("exp");render();
if(API){
  document.getElementById("syncChip").style.display="";
  document.getElementById("logoutBtn").style.display="";
  if(token){
    setSync("saving");
    pullRemote().then(ok=>{if(ok){applyTheme();render();setSync("ok");checkDuePayments();scheduleAssetPriceRefresh();}}).catch(()=>setSync("offline"));
  }else{
    showLogin();
  }
}else{
  checkDuePayments();
  scheduleAssetPriceRefresh();
}
