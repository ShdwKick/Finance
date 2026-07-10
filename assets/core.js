"use strict";

const CATS={
  exp:[
    {n:"Продукты",e:"🛒"},{n:"Кафе и рестораны",e:"🍔"},{n:"Транспорт",e:"🚗"},
    {n:"Жильё и ЖКХ",e:"🏠"},{n:"Здоровье",e:"💊"},{n:"Одежда",e:"👕"},
    {n:"Развлечения",e:"🎮"},{n:"Связь и интернет",e:"📱"},{n:"Подписки",e:"📺"},
    {n:"Образование",e:"📚"},{n:"Платёж по долгу",e:"🏦"},{n:"Другое",e:"💭"}
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
const API=(location.protocol==="http:"||location.protocol==="https:")?location.origin:null;
let token=API?localStorage.getItem("fin_token"):null;
let syncTimer=null;

let state=load();
let curType="exp";
let editId=null, selEmoji="🎯";
let amtMode=null, amtId=null; // for deposit/payment dialog

function normalize(s){
  s=(s&&typeof s==="object")?s:{};
  s.tx=Array.isArray(s.tx)?s.tx:[];
  s.goals=Array.isArray(s.goals)?s.goals:[];
  s.debts=Array.isArray(s.debts)?s.debts:[];
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
  s.assets=Array.isArray(s.assets)?s.assets:[];
  return s;
}
function load(){
  try{const r=localStorage.getItem("myFinance");if(r)return normalize(JSON.parse(r));}catch(e){}
  return normalize({});
}
function save(){
  localStorage.setItem("myFinance",JSON.stringify(state));
  if(API&&token){clearTimeout(syncTimer);syncTimer=setTimeout(pushRemote,700);setSync("saving");}
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

/* ---------- server sync ---------- */
async function pushRemote(){
  if(!API||!token)return;
  try{
    const r=await fetch(API+"/api/state",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({data:state})});
    if(r.status===401)return authFail();
    if(!r.ok)throw 0;
    setSync("ok");
  }catch(e){setSync("offline");}
}
async function pullRemote(){
  const r=await fetch(API+"/api/state",{headers:{"Authorization":"Bearer "+token}});
  if(r.status===401){authFail();return false;}
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
function authFail(){token=null;localStorage.removeItem("fin_token");showLogin();}
function showLogin(){document.getElementById("loginScrim").classList.add("show");setTimeout(()=>document.getElementById("liUser").focus(),120);}
function hideLogin(){document.getElementById("loginScrim").classList.remove("show");}
async function doLogin(){
  const u=document.getElementById("liUser").value.trim(),p=document.getElementById("liPass").value;
  const err=document.getElementById("loginErr");err.textContent="";
  if(!u||!p){err.textContent="Введите логин и пароль";return;}
  try{
    const r=await fetch(API+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});
    if(r.status===401){err.textContent="Неверный логин или пароль";return;}
    if(!r.ok)throw 0;
    const j=await r.json();token=j.token;localStorage.setItem("fin_token",token);
    document.getElementById("liPass").value="";hideLogin();
    try{await pullRemote();}catch(e){}
    applyTheme();render();setSync("ok");snack("Добро пожаловать!");
    checkDuePayments();
    scheduleAssetPriceRefresh();
  }catch(e){err.textContent="Не удалось подключиться к серверу";}
}
function logout(){token=null;localStorage.removeItem("fin_token");setSync("offline");showLogin();}
const uid=()=>Date.now().toString(36)+Math.floor(performance.now()*1e3%1e3).toString(36)+Math.floor(Math.random()*1e6).toString(36);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
