"use strict";
/* Математика кредита/ипотеки: аннуитет + дифференцированный график, симуляция
   досрочного погашения. Общий модуль — используется и в приложении (аналитика по
   своим долгам, только аннуитет — см. app.js), и в публичном калькуляторе
   (оба типа). Чистые функции, без обращения к state/DOM. */

function loanMonthlyRate(annualPct){ return (annualPct||0)/100/12; }

/* фиксированный ежемесячный платёж по аннуитету */
function annuityPayment(principal,mRate,months){
  if(months<=0)return 0;
  if(mRate<=0)return principal/months;
  return principal*mRate/(1-Math.pow(1+mRate,-months));
}

/* сколько месяцев потребуется гасить аннуитетным платежом payment — может быть
   дробным (округляем вверх при построении графика); Infinity, если платёж не
   покрывает даже проценты первого периода (долг никогда не будет погашен) */
function solveAnnuityMonths(principal,mRate,payment){
  if(payment<=0)return Infinity;
  if(mRate<=0)return principal/payment;
  if(payment<=principal*mRate)return Infinity;
  return -Math.log(1-principal*mRate/payment)/Math.log(1+mRate);
}

/* полный график аннуитета по фиксированному платежу, month-by-month, пока баланс не обнулится.
   extraPayments — необязательный массив {afterMonth, amount, strategy:"term"|"payment"} —
   разовые досрочные платежи, применяются ПОСЛЕ обычного платежа месяца afterMonth. */
function buildAnnuitySchedule({principal,annualPct,payment,maxMonths=600,extraPayments=[]}){
  const mRate=loanMonthlyRate(annualPct);
  const rows=[];
  let balance=principal,n=0,curPayment=payment,totalInterest=0,totalPaid=0;
  while(balance>0.01&&n<maxMonths){
    n++;
    const interest=balance*mRate;
    let principalPart=curPayment-interest;
    let pay=curPayment;
    if(principalPart>=balance){ // последний обычный платёж — не переплачиваем
      principalPart=balance;
      pay=balance+interest;
    }
    balance=Math.max(0,balance-principalPart);
    totalInterest+=interest;totalPaid+=pay;
    rows.push({n,interest:round2(interest),principal:round2(principalPart),payment:round2(pay),balance:round2(balance)});
    const extra=extraPayments.find(e=>e.afterMonth===n);
    if(extra&&balance>0){
      const extraAmt=Math.min(extra.amount,balance);
      balance=Math.max(0,balance-extraAmt);
      totalPaid+=extraAmt;
      rows[rows.length-1].extra=round2(extraAmt);
      rows[rows.length-1].balance=round2(balance);
      if(extra.strategy==="payment"&&balance>0){
        const remainMonths=Math.max(1,Math.ceil(solveAnnuityMonths(balance,mRate,curPayment)));
        curPayment=annuityPayment(balance,mRate,remainMonths);
      }
      // strategy==="term" (по умолчанию) — платёж не трогаем, срок сократится сам, цикл увидит это по balance
    }
  }
  return {rows,totalInterest:round2(totalInterest),totalPaid:round2(totalPaid),months:n};
}

/* график дифференцированных платежей — тело кредита гасится равными долями,
   платёж каждый месяц уменьшается. Нужен явный срок (months), в отличие от аннуитета. */
function buildDifferentiatedSchedule({principal,annualPct,months}){
  const mRate=loanMonthlyRate(annualPct);
  const principalPart=principal/months;
  const rows=[];
  let balance=principal,totalInterest=0,totalPaid=0;
  for(let n=1;n<=months;n++){
    const interest=balance*mRate;
    const pay=principalPart+interest;
    balance=Math.max(0,balance-principalPart);
    totalInterest+=interest;totalPaid+=pay;
    rows.push({n,interest:round2(interest),principal:round2(principalPart),payment:round2(pay),balance:round2(balance)});
  }
  return {rows,totalInterest:round2(totalInterest),totalPaid:round2(totalPaid),months};
}

function round2(n){ return Math.round((n+Number.EPSILON)*100)/100; }
