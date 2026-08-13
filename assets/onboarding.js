"use strict";
/* Пошаговое обучение для новых пользователей — coachmark-тур по основным
   панелям приложения. Показывается один раз (флаг state.onboardingDone,
   синхронизируется с сервером как обычная настройка), повторно открыть
   можно из профиля («Показать обучение заново»). */

const ONBOARDING_STEPS=[
  {title:"Добро пожаловать в «Мои финансы»!",desc:"Покажем за минуту, где что лежит. Пропустить можно в любой момент.",target:null},
  {title:"Добавляйте операции здесь",desc:"Расход или доход, сумма, категория — и «Добавить». Есть мини-калькулятор в поле суммы и учёт трат с кредитки.",target:"#onbAddPanel",tab:"overview"},
  {title:"Баланс и итоги",desc:"Общий баланс, доходы и расходы, долги — сразу видно, как обстоят дела.",target:".overview-grid",tab:"overview"},
  {title:"Три вкладки",desc:"«Обзор» — повседневные дела, «Аналитика» — графики и динамика по месяцам, «Активы» — накопления и инвестиции.",target:".tab-seg",tab:"overview"},
  {title:"История операций",desc:"Клик по операции открывает её для редактирования. Есть поиск и фильтры по сумме, периоду и категории.",target:"#onbHistoryPanel",tab:"overview"},
  {title:"Цели",desc:"Копите на что-то конкретное — прогресс сразу виден на карточке цели.",target:"#onbGoalsPanel",tab:"overview"},
  {title:"Долги и кредиты",desc:"Кредитки и обычные кредиты — для кредита можно указать ставку и дату, и открыть «Подробнее»: график, реальная переплата и калькулятор досрочного погашения.",target:"#onbDebtPanel",tab:"overview"},
  {title:"Активы и сбережения",desc:"Накопления, инвестиции, тикеры MOEX с автообновлением курса — разбивка и динамика на вкладке «Активы».",target:"#tabAssets",tab:"overview"},
  {title:"Профиль",desc:"Тема оформления, резервная копия данных и это обучение — всегда можно открыть заново отсюда.",target:"#profileBtn",tab:"overview"},
  {title:"Готово!",desc:"Теперь вы знаете, где что искать. Хорошего учёта финансов!",target:null},
];

let obIndex=0,obActive=false;

function maybeStartOnboarding(){
  if(!state.onboardingDone)startOnboarding();
}
function startOnboarding(){
  obActive=true;
  document.getElementById("onbScrim").classList.add("show");
  window.addEventListener("resize",repositionOnboarding);
  showObStep(0);
}
function endOnboarding(){
  if(!obActive)return;
  obActive=false;
  document.getElementById("onbScrim").classList.remove("show");
  window.removeEventListener("resize",repositionOnboarding);
  if(!state.onboardingDone){state.onboardingDone=true;save();}
}
function nextObStep(){ obIndex<ONBOARDING_STEPS.length-1?showObStep(obIndex+1):endOnboarding(); }
function prevObStep(){ if(obIndex>0)showObStep(obIndex-1); }
function skipOnboarding(){ endOnboarding(); }

function showObStep(i){
  obIndex=i;
  const step=ONBOARDING_STEPS[i];
  if(step.tab)setPageTab(step.tab);
  const target=step.target?document.querySelector(step.target):null;
  if(step.target&&!target){
    // элемента нет в текущей раскладке (например, скрыт на мобильном) — пропускаем шаг молча
    return i<ONBOARDING_STEPS.length-1?showObStep(i+1):endOnboarding();
  }
  if(target)target.scrollIntoView({block:"center",behavior:"instant"});
  requestAnimationFrame(()=>renderObStep(step,target,i));
}
function renderObStep(step,target,i){
  const spot=document.getElementById("onbSpotlight");
  const card=document.getElementById("onbCard");
  card.innerHTML=`
    <div class="onb-dots">${ONBOARDING_STEPS.map((_,idx)=>`<i class="${idx===i?"on":""}"></i>`).join("")}</div>
    <h3>${esc(step.title)}</h3>
    <p>${esc(step.desc)}</p>
    <div class="onb-actions">
      ${i>0?'<button class="btn text" onclick="prevObStep()">Назад</button>':'<button class="btn text" onclick="skipOnboarding()">Пропустить</button>'}
      <div class="spacer"></div>
      <button class="btn filled" onclick="nextObStep()">${i<ONBOARDING_STEPS.length-1?"Далее":"Готово"}</button>
    </div>`;
  if(target){
    const r=target.getBoundingClientRect();
    const pad=6;
    spot.style.display="block";
    spot.style.top=(r.top-pad)+"px";spot.style.left=(r.left-pad)+"px";
    spot.style.width=(r.width+pad*2)+"px";spot.style.height=(r.height+pad*2)+"px";
    card.classList.remove("center");
    positionObCard(card,r);
  }else{
    spot.style.display="none";
    card.classList.add("center");
    card.style.top="";card.style.left="";
  }
}
/* карточка встаёт под целью, если влезает; иначе над ней; иначе — сбоку по центру экрана */
function positionObCard(card,targetRect){
  card.style.visibility="hidden";card.style.top="0px";card.style.left="0px";
  const cw=card.offsetWidth,ch=card.offsetHeight,margin=14,vw=innerWidth,vh=innerHeight;
  let top;
  if(targetRect.bottom+margin+ch<=vh)top=targetRect.bottom+margin;
  else if(targetRect.top-margin-ch>=0)top=targetRect.top-margin-ch;
  else top=Math.max(margin,Math.min(vh-ch-margin,(vh-ch)/2));
  const left=Math.max(margin,Math.min(vw-cw-margin,targetRect.left+targetRect.width/2-cw/2));
  card.style.top=top+"px";card.style.left=left+"px";
  card.style.visibility="";
}
/* пересчёт позиции при resize/повороте экрана, пока тур открыт */
function repositionOnboarding(){
  if(!obActive)return;
  const step=ONBOARDING_STEPS[obIndex];
  const target=step.target?document.querySelector(step.target):null;
  renderObStep(step,target,obIndex);
}
