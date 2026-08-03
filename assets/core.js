"use strict";

const CATS={
  exp:[
    {n:"Продукты",e:"🛒"},{n:"Кафе и рестораны",e:"🍔"},{n:"Транспорт",e:"🚗"},
    {n:"Жильё и ЖКХ",e:"🏠"},{n:"Здоровье",e:"💊"},{n:"Одежда",e:"👕"},
    {n:"Развлечения",e:"🎮"},{n:"Связь и интернет",e:"📱"},{n:"Подписки",e:"📺"},
    {n:"Образование",e:"📚"},{n:"Платёж по долгу",e:"🏦"},{n:"Проценты по кредиту",e:"💸"},{n:"Другое",e:"💭"}
  ],
  inc:[
    {n:"Зарплата",e:"💼"},{n:"Подработка",e:"🛠️"},{n:"Подарок",e:"🎁"},
    {n:"Инвестиции",e:"📈"},{n:"Возврат",e:"↩️"},{n:"Другое",e:"💭"}
  ]
};
const GOAL_EMOJIS=["🎯","🏖️","🚗","🏠","💍","✈️","📱","💻","🎓","🎸","🐶","🎮","👟","💰","🛋️","🏝️"];
const DEBT_EMOJIS=["🏦","🏠","🚗","💳","📱","🎓","👤","🧾","💸","🛠️","⚡","📉"];
const CAT_COLORS=["#00a06b","#3f8cff","#ff7043","#ab47bc","#ffb300","#26c6da","#ec407a","#8d6e63","#5c6bc0","#78909c"];
const FIX_EMOJIS=["🏠","💡","📶","📱","📺","🚗","🏦","🍽️","🎓","💧","🔥","🛡️"];
const ASSET_EMOJIS=["💰","🏦","📈","💎","🪙","🏠","🚗","💳","🐖","📊","💵","🧾"];

/* ---------- sync layer (only active when served over http, not file://) ---------- */
const syncCapable=location.protocol==="http:"||location.protocol==="https:";
/* адрес API: пусто = тот же домен, что и сама страница (относительные запросы).
   Пригодится, если бэкенд когда-нибудь переедет на отдельный домен. */
let apiBase=localStorage.getItem("fin_api_base")||"";
function setApiBase(v){
  apiBase=String(v||"").trim().replace(/\/+$/,"");
  if(apiBase)localStorage.setItem("fin_api_base",apiBase);else localStorage.removeItem("fin_api_base");
}
/* Аккаунтами заведует общий auth-сервис: логин/пароль этот проект больше не видит,
   он только получает от него токены и шлёт их в свой /api/v1/state. */
let auth=null;      // клиент авторизации, создаётся в initAuth()
let authed=false;   // есть ли действующая авторизация
let syncTimer=null;

/* объявлены до load() ниже: normalize() пишет сюда отчёт уже при самой первой загрузке */
let normalizeReport=null;
let normSeq=0;

let state=load();
let curType="exp";
let editId=null, selEmoji="🎯";
let amtMode=null, amtId=null; // for deposit/payment dialog

/* ---------- проверка формы записей ---------- */
/* Правило прежнее: normalize() — единственная точка совместимости бэкапов, поэтому незнакомые
   поля записей мы не трогаем (в старых копиях их хватает). Чиним только то, без чего ломается
   отрисовка, и выбрасываем лишь то, что починить нельзя: одна запись без type роняла весь render.
   Сколько выброшено — в normalizeReport; в сам state это не пишем, иначе счётчик уедет в бэкап. */
function normId(prefix){return prefix+"-"+(normSeq++)+"-"+Math.random().toString(36).slice(2,8);}
/* число из чего угодно; NaN — если это не число. Строки принимаем в том же виде, что и поля ввода
   (parseAmount): «1500,5», «12 000» — так пишут в копиях, правленных руками. */
function normNum(v){
  if(typeof v==="number")return isFinite(v)?v:NaN;
  if(typeof v!=="string")return NaN;
  const s=v.replace(/\s/g,"").replace(",",".");
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s)?+s:NaN;
}
/* сумма: число ≥ 0, округлённое до копеек; NaN — если сумму не восстановить */
function normAmount(v){
  const n=normNum(v);
  return n>=0?Math.round((n+Number.EPSILON)*100)/100:NaN;
}
function normStr(v,def){
  const s=(typeof v==="string"||typeof v==="number")?String(v).trim():"";
  return s||def;
}
/* иконка попадает в разметку как есть (без esc), поэтому пускаем только короткую строку без спецсимволов */
function normEmoji(v,def){
  const s=typeof v==="string"?v.trim():"";
  return s&&s.length<=16&&!/[<>&"']/.test(s)?s:def;
}
/* дата обязана парситься: иначе сортировка, графики и fmtDate дают «Invalid Date» */
function dateOk(v){return Number.isFinite(typeof v==="number"?v:Date.parse(v));}
function catExists(type,name){return (CATS[type]||[]).some(c=>c.n===name);}
/* шаг копилки: "smart" либо положительное число (селектор отдаёт строку — её и храним, см. piggyStep) */
function normPiggyMode(m){
  if(m==="smart")return"smart";
  const n=normNum(m);
  return n>0?String(n):"smart";
}

/* операции: тип и сумму восстановить нельзя — такие записи выбрасываем; остальное чиним */
function normTxList(list,nowIso){
  const kept=[];let dropped=0;
  list.forEach(t=>{
    if(!t||typeof t!=="object"){dropped++;return;}
    if(t.type!=="exp"&&t.type!=="inc"){dropped++;return;} // расход это или доход — из записи не узнать
    const amount=normAmount(t.amount);
    if(isNaN(amount)){dropped++;return;}
    t.amount=amount;
    if(typeof t.id!=="string"||!t.id)t.id=normId("tx");
    if(!catExists(t.type,t.cat))t.cat="Другое"; // свои категории пользователь не создаёт, незнакомую сводим к «Другое»
    if(typeof t.note!=="string")t.note=normStr(t.note,""); // в разметку идёт через esc, но объект дал бы «[object Object]»
    if(!dateOk(t.date))t.date=nowIso;
    // ссылки на другие сущности: либо строковый id, либо null — иначе ломаются find/findCard
    ["refundFor","cardId","cardRepay","piggyId"].forEach(k=>{if(k in t&&typeof t[k]!=="string")t[k]=null;});
    kept.push(t);
  });
  // возврат, привязанный к выброшенной операции, тихо съел бы свою сумму в аналитике (netTxAmount)
  const ids=new Set(kept.map(t=>t.id));
  kept.forEach(t=>{if(t.refundFor&&!ids.has(t.refundFor))t.refundFor=null;});
  return{list:kept,dropped};
}
/* цели: без целевой суммы прогресс не посчитать (выходил NaN%) — такую цель выбрасываем */
function normGoalList(list){
  const kept=[];let dropped=0;
  list.forEach(g=>{
    if(!g||typeof g!=="object"){dropped++;return;}
    const target=normAmount(g.target);
    if(isNaN(target)||target<=0){dropped++;return;}
    const saved=normAmount(g.saved);
    g.target=target;
    g.saved=isNaN(saved)?0:saved;
    g.name=normStr(g.name,"Без названия");
    g.emoji=normEmoji(g.emoji,"🎯");
    if(typeof g.id!=="string"||!g.id)g.id=normId("goal");
    kept.push(g);
  });
  return{list:kept,dropped};
}
/* долги: суммы чиним нулём — NaN здесь уводил в NaN и баланс, и чистую стоимость (debtOwed) */
function normDebtList(list){
  const kept=[];let dropped=0;
  list.forEach(d=>{
    if(!d||typeof d!=="object"){dropped++;return;}
    if(typeof d.id!=="string"||!d.id)d.id=normId("debt");
    d.name=normStr(d.name,"Без названия");
    d.emoji=normEmoji(d.emoji,d.kind==="card"?"💳":"🏦");
    if(d.kind==="card"){
      // кредитка: {kind:"card", limit, used}; обычный кредит kind не имеет (считается "loan")
      d.limit=Math.max(0,normAmount(d.limit)||0);
      d.used=Math.max(0,normAmount(d.used)||0);
      delete d.monthly;
    }else{
      d.total=Math.max(0,normAmount(d.total)||0);
      d.remaining=Math.max(0,normAmount(d.remaining)||0);
      d.monthly=Math.max(0,normAmount(d.monthly)||0);
    }
    kept.push(d);
  });
  return{list:kept,dropped};
}
/* обязательные платежи: без суммы платёж не показать и не сложить в итог месяца — выбрасываем */
function normFixedList(list){
  const kept=[];let dropped=0;
  list.forEach(f=>{
    if(!f||typeof f!=="object"){dropped++;return;}
    const amount=normAmount(f.amount);
    if(isNaN(amount)||amount<=0){dropped++;return;}
    f.amount=amount;
    // миграция: было одно число месяца (f.day), стало несколько (f.days[])
    const days=Array.isArray(f.days)?f.days:(f.day?[f.day]:[]);
    f.days=[...new Set(days.map(d=>parseInt(d,10)).filter(d=>d>=1&&d<=31))].sort((a,b)=>a-b);
    delete f.day;
    if(typeof f.id!=="string"||!f.id)f.id=normId("fixed");
    f.name=normStr(f.name,"Без названия");
    f.emoji=normEmoji(f.emoji,"🏠");
    // категорию с CATS не сверяем: в старых копиях она могла называться иначе, а обнулить — потерять привязку
    f.category=normStr(f.category,null);
    kept.push(f);
  });
  return{list:kept,dropped};
}
/* активы: сумму чиним (NaN портил «итого активов» и чистую стоимость), выбрасываем только мусор */
function normAssetList(list){
  const kept=[];let dropped=0;
  list.forEach(a=>{
    if(!a||typeof a!=="object"){dropped++;return;}
    delete a.piggyRound; // копилка-флаг на активе упразднён — теперь отдельная сущность piggy
    if(typeof a.id!=="string"||!a.id)a.id=normId("asset");
    a.name=normStr(a.name,"Без названия");
    a.emoji=normEmoji(a.emoji,"💰");
    const qty=normNum(a.qty),price=normNum(a.lastPrice);
    a.qty=qty>0?qty:null;
    a.lastPrice=price>=0?price:null;
    if(!dateOk(a.priceUpdated))a.priceUpdated=null;
    // тикерный актив без количества показывался как «null шт.» — оставляем его обычным, ручным
    a.ticker=normStr(a.ticker,null);
    if(a.ticker&&!a.qty)a.ticker=null;
    if(!a.ticker){a.qty=null;a.lastPrice=null;a.priceUpdated=null;}
    const amount=normAmount(a.amount);
    a.amount=!isNaN(amount)?amount
      :(a.ticker&&a.lastPrice?Math.round(a.qty*a.lastPrice*100)/100:0);
    kept.push(a);
  });
  return{list:kept,dropped};
}

function normalize(s){
  s=(s&&typeof s==="object")?s:{};
  const nowIso=new Date().toISOString();
  const tx=normTxList(Array.isArray(s.tx)?s.tx:[],nowIso);
  const goals=normGoalList(Array.isArray(s.goals)?s.goals:[]);
  const debts=normDebtList(Array.isArray(s.debts)?s.debts:[]);
  const fixed=normFixedList(Array.isArray(s.fixed)?s.fixed:[]);
  const assets=normAssetList(Array.isArray(s.assets)?s.assets:[]);
  s.tx=tx.list;s.goals=goals.list;s.debts=debts.list;s.fixed=fixed.list;s.assets=assets.list;
  normalizeReport={
    tx:tx.dropped,goals:goals.dropped,debts:debts.dropped,fixed:fixed.dropped,assets:assets.dropped,
    total:tx.dropped+goals.dropped+debts.dropped+fixed.dropped+assets.dropped
  };
  const income=normNum(s.monthlyIncome);
  s.monthlyIncome=income>0?income:null; // строка/мусор здесь давала NaN% в ПДН
  s.theme=s.theme==="dark"?"dark":"light";
  s.hideBalance=!!s.hideBalance;
  s.fixedSkips=(Array.isArray(s.fixedSkips)?s.fixedSkips:[]).filter(k=>typeof k==="string");
  // инвесткопилка: постоянная сущность, по умолчанию выключена
  s.piggy=(s.piggy&&typeof s.piggy==="object")
    ?{enabled:!!s.piggy.enabled,mode:normPiggyMode(s.piggy.mode),amount:Math.max(0,normAmount(s.piggy.amount)||0)}
    :{enabled:false,mode:"smart",amount:0};
  s.displayName=typeof s.displayName==="string"?s.displayName.trim().slice(0,60):"";
  return s;
}
function load(){
  try{const r=localStorage.getItem("myFinance");if(r)return normalize(JSON.parse(r));}catch(e){}
  return normalize({});
}
function save(){
  localStorage.setItem("myFinance",JSON.stringify(state));
  if(syncCapable&&authed){clearTimeout(syncTimer);syncTimer=setTimeout(pushRemote,700);setSync("saving");}
}

/* деньги: показываем копейки только когда они есть */
function fmt(n){
  n=Math.round((n+Number.EPSILON)*100)/100;
  const frac=n%1!==0;
  return new Intl.NumberFormat("ru-RU",{minimumFractionDigits:frac?2:0,maximumFractionDigits:2}).format(n)+" ₽";
}
/* склонение существительного при числе: plural(2,["запись","записи","записей"]) → "записи" */
function plural(n,forms){
  const a=Math.abs(n)%100,b=a%10;
  if(a>10&&a<20)return forms[2];
  if(b>1&&b<5)return forms[1];
  if(b===1)return forms[0];
  return forms[2];
}
/* разбор ввода: принимает и запятую, и точку; округляет до копеек */
function parseAmount(v){
  v=String(v==null?"":v).replace(/\s/g,"").replace(",",".");
  const n=parseFloat(v);
  return isNaN(n)?NaN:Math.round((n+Number.EPSILON)*100)/100;
}
/* живая очистка полей суммы: только цифры и один разделитель, чтобы поле не "прыгало" от лишних символов */
function sanitizeAmt(el){
  const v=el.value;
  let cleaned=v.replace(/[^0-9.,]/g,"");
  const sep=cleaned.search(/[.,]/);
  if(sep!==-1)cleaned=cleaned.slice(0,sep+1)+cleaned.slice(sep+1).replace(/[.,]/g,"");
  if(cleaned!==v){
    const pos=Math.max(0,(el.selectionStart||cleaned.length)-(v.length-cleaned.length));
    el.value=cleaned;
    try{el.setSelectionRange(pos,pos);}catch(e){}
  }
}

/* ---------- авторизация через общий сервис ---------- */
/* Адрес auth-сервиса приходит с бэкенда (/api/v1/config), чтобы не быть зашитым в статику.
   Возвращает true, если авторизация есть и можно синхронизироваться. */
async function initAuth(){
  localStorage.removeItem("fin_token"); // ключ прежней схемы, когда токены выдавал сам Finance
  const cfg=await (await fetch(apiBase+"/api/v1/config")).json();
  auth=createAuthClient({
    authBase:cfg.authBase,
    clientId:cfg.clientId,
    redirectUri:location.origin+location.pathname,
    storagePrefix:"fin"
  });
  /* Вернулись со страницы входа с одноразовым кодом — меняем его на токены.
     Сам код из адресной строки убирается внутри handleRedirect. */
  await auth.handleRedirect();
  authed=auth.isAuthenticated();
  return authed;
}
function startLogin(){
  if(!auth){document.getElementById("loginErr").textContent="Сервер недоступен, попробуйте обновить страницу";return;}
  /* Карточка уходит, и только потом происходит навигация на auth-домен —
     иначе подмена страницы выглядит рывком. Фон при этом остаётся: он одинаков
     здесь и там, и именно он склеивает две страницы в один переход.
     Задержка обязана совпадать с длительностью .bh-leaving в brand.css. */
  const card=document.querySelector("#loginScrim .login-card");
  const instant=matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!card||instant)return auth.login();
  card.classList.add("bh-leaving");
  setTimeout(()=>auth.login(),200);
}
function openAccount(){if(auth)window.open(auth.accountUrl(),"_blank","noopener");}

/* ---------- server sync ---------- */
/* auth.fetch сам подставит токен, а протухший — молча обновит и повторит запрос.
   AuthRequiredError означает, что обновить уже нечем: пора на страницу входа. */
async function pushRemote(){
  if(!syncCapable||!authed)return;
  try{
    const r=await auth.fetch(apiBase+"/api/v1/state",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:state})});
    if(!r.ok)throw 0;
    setSync("ok");
  }catch(e){
    if(e&&e.name==="AuthRequiredError")return authFail();
    setSync("offline");
  }
}
async function pullRemote(){
  let r;
  try{r=await auth.fetch(apiBase+"/api/v1/state");}
  catch(e){if(e&&e.name==="AuthRequiredError"){authFail();return false;}throw e;}
  if(!r.ok)throw new Error("net");
  const j=await r.json();
  if(j&&j.data&&typeof j.data==="object"){state=normalize(j.data);localStorage.setItem("myFinance",JSON.stringify(state));}
  return true;
}
function setSync(mode){
  const c=document.getElementById("syncChip"),t=document.getElementById("syncText");
  if(!c)return;
  c.className="sync"+(mode==="saving"?" saving":mode==="offline"?" offline":"");
  t.textContent=mode==="saving"?"Сохранение…":mode==="offline"?"Нет связи":"Синхронизировано";
}
function authFail(){authed=false;if(auth)auth.clearTokens();setSync("offline");showLogin();}
function showLogin(){
  document.getElementById("loginErr").textContent="";
  document.getElementById("loginScrim").classList.add("show");
}
function logout(){
  authed=false;
  if(auth)auth.logout();            // отзовёт токен и уведёт на выход из общего аккаунта
  else{setSync("offline");showLogin();}
}
const uid=()=>Date.now().toString(36)+Math.floor(performance.now()*1e3%1e3).toString(36)+Math.floor(Math.random()*1e6).toString(36);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
