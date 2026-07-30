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
   он только получает от него токены и шлёт их в свой /api/state. */
let auth=null;      // клиент авторизации, создаётся в initAuth()
let authed=false;   // есть ли действующая авторизация
let syncTimer=null;

let state=load();
let curType="exp";
let editId=null, selEmoji="🎯";
let amtMode=null, amtId=null; // for deposit/payment dialog

function normalize(s){
  s=(s&&typeof s==="object")?s:{};
  s.tx=Array.isArray(s.tx)?s.tx:[];
  s.goals=Array.isArray(s.goals)?s.goals:[];
  s.debts=(Array.isArray(s.debts)?s.debts:[]).map(d=>{
    // кредитка: {kind:"card", limit, used}; обычный кредит kind не имеет (считается "loan")
    if(d.kind==="card"){d.limit=Math.max(0,+d.limit||0);d.used=Math.max(0,+d.used||0);delete d.monthly;}
    return d;
  });
  s.fixed=(Array.isArray(s.fixed)?s.fixed:[]).map(f=>{
    // миграция: было одно число месяца (f.day), стало несколько (f.days[])
    if(!Array.isArray(f.days))f.days=f.day?[f.day]:[];
    delete f.day;
    return f;
  });
  s.monthlyIncome=(s.monthlyIncome??null);
  s.theme=s.theme||"light";
  s.hideBalance=!!s.hideBalance;
  s.fixedSkips=Array.isArray(s.fixedSkips)?s.fixedSkips:[];
  s.assets=(Array.isArray(s.assets)?s.assets:[]).map(a=>{delete a.piggyRound;return a;}); // копилка-флаг на активе упразднён — теперь отдельная сущность piggy
  // инвесткопилка: постоянная сущность, по умолчанию выключена
  s.piggy=(s.piggy&&typeof s.piggy==="object")
    ?{enabled:!!s.piggy.enabled,mode:s.piggy.mode||"smart",amount:Math.max(0,+s.piggy.amount||0)}
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
/* Адрес auth-сервиса приходит с бэкенда (/api/config), чтобы не быть зашитым в статику.
   Возвращает true, если авторизация есть и можно синхронизироваться. */
async function initAuth(){
  localStorage.removeItem("fin_token"); // ключ прежней схемы, когда токены выдавал сам Finance
  const cfg=await (await fetch(apiBase+"/api/config")).json();
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
  auth.login();
}
function openAccount(){if(auth)window.open(auth.accountUrl(),"_blank","noopener");}

/* ---------- server sync ---------- */
/* auth.fetch сам подставит токен, а протухший — молча обновит и повторит запрос.
   AuthRequiredError означает, что обновить уже нечем: пора на страницу входа. */
async function pushRemote(){
  if(!syncCapable||!authed)return;
  try{
    const r=await auth.fetch(apiBase+"/api/state",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:state})});
    if(!r.ok)throw 0;
    setSync("ok");
  }catch(e){
    if(e&&e.name==="AuthRequiredError")return authFail();
    setSync("offline");
  }
}
async function pullRemote(){
  let r;
  try{r=await auth.fetch(apiBase+"/api/state");}
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
