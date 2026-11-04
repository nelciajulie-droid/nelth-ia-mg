import{g as ge,s as pe,p as ve,o as xe,a as Te,b as be,_ as l,c as dt,d as we,l as ot,j as _e,n as De,q as Ce,y as Se}from"./DOyPjbc_.js";import{Z as Yt,_ as Ot,r as q}from"./_waXOR9c.js";import{d as Ee}from"./CYpobbl2.js";import{s as vt}from"./BX5WB7ra.js";import{t as Me,m as Ie,a as Ae,i as Le,b as jt,c as qt,d as Fe,e as Ye,f as Oe,g as We,h as Ve,j as ze,k as Pe,l as Ut,n as Zt,o as Qt,s as Kt,p as Jt}from"./CrATNjtF.js";import{l as Re}from"./CrKpsNbG.js";function Ne(t){return t}var Tt=1,St=2,Mt=3,xt=4,te=1e-6;function Be(t){return"translate("+t+",0)"}function $e(t){return"translate(0,"+t+")"}function He(t){return e=>+t(e)}function Ge(t,e){return e=Math.max(0,t.bandwidth()-e*2)/2,t.round()&&(e=Math.round(e)),i=>+t(i)+e}function Xe(){return!this.__axis}function ne(t,e){var i=[],n=null,s=null,k=6,m=6,v=3,M=typeof window<"u"&&window.devicePixelRatio>1?0:.5,I=t===Tt||t===xt?-1:1,x=t===xt||t===St?"x":"y",Y=t===Tt||t===Mt?Be:$e;function w(b){var Z=n??(e.ticks?e.ticks.apply(e,i):e.domain()),X=s??(e.tickFormat?e.tickFormat.apply(e,i):Ne),h=Math.max(k,0)+v,A=e.range(),L=+A[0]+M,F=+A[A.length-1]+M,N=(e.bandwidth?Ge:He)(e.copy(),M),P=b.selection?b.selection():b,j=P.selectAll(".domain").data([null]),V=P.selectAll(".tick").data(Z,e).order(),$=V.exit(),B=V.enter().append("g").attr("class","tick"),y=V.select("line"),T=V.select("text");j=j.merge(j.enter().insert("path",".tick").attr("class","domain").attr("stroke","currentColor")),V=V.merge(B),y=y.merge(B.append("line").attr("stroke","currentColor").attr(x+"2",I*k)),T=T.merge(B.append("text").attr("fill","currentColor").attr(x,I*h).attr("dy",t===Tt?"0em":t===Mt?"0.71em":"0.32em")),b!==P&&(j=j.transition(b),V=V.transition(b),y=y.transition(b),T=T.transition(b),$=$.transition(b).attr("opacity",te).attr("transform",function(p){return isFinite(p=N(p))?Y(p+M):this.getAttribute("transform")}),B.attr("opacity",te).attr("transform",function(p){var g=this.parentNode.__axis;return Y((g&&isFinite(g=g(p))?g:N(p))+M)})),$.remove(),j.attr("d",t===xt||t===St?m?"M"+I*m+","+L+"H"+M+"V"+F+"H"+I*m:"M"+M+","+L+"V"+F:m?"M"+L+","+I*m+"V"+M+"H"+F+"V"+I*m:"M"+L+","+M+"H"+F),V.attr("opacity",1).attr("transform",function(p){return Y(N(p)+M)}),y.attr(x+"2",I*k),T.attr(x,I*h).text(X),P.filter(Xe).attr("fill","none").attr("font-size",10).attr("font-family","sans-serif").attr("text-anchor",t===St?"start":t===xt?"end":"middle"),P.each(function(){this.__axis=N})}return w.scale=function(b){return arguments.length?(e=b,w):e},w.ticks=function(){return i=Array.from(arguments),w},w.tickArguments=function(b){return arguments.length?(i=b==null?[]:Array.from(b),w):i.slice()},w.tickValues=function(b){return arguments.length?(n=b==null?null:Array.from(b),w):n&&n.slice()},w.tickFormat=function(b){return arguments.length?(s=b,w):s},w.tickSize=function(b){return arguments.length?(k=m=+b,w):k},w.tickSizeInner=function(b){return arguments.length?(k=+b,w):k},w.tickSizeOuter=function(b){return arguments.length?(m=+b,w):m},w.tickPadding=function(b){return arguments.length?(v=+b,w):v},w.offset=function(b){return arguments.length?(M=+b,w):M},w}function je(t){return ne(Tt,t)}function qe(t){return ne(Mt,t)}var se={exports:{}};(function(t,e){(function(i,n){t.exports=n()})(Yt,function(){var i="day";return function(n,s,k){var m=function(I){return I.add(4-I.isoWeekday(),i)},v=s.prototype;v.isoWeekYear=function(){return m(this).year()},v.isoWeek=function(I){if(!this.$utils().u(I))return this.add(7*(I-this.isoWeek()),i);var x,Y,w,b,Z=m(this),X=(x=this.isoWeekYear(),Y=this.$u,w=(Y?k.utc:k)().year(x).startOf("year"),b=4-w.isoWeekday(),w.isoWeekday()>4&&(b+=7),w.add(b,i));return Z.diff(X,"week")+1},v.isoWeekday=function(I){return this.$utils().u(I)?this.day()||7:this.day(this.day()%7?I:I-7)};var M=v.startOf;v.startOf=function(I,x){var Y=this.$utils(),w=!!Y.u(x)||x;return Y.p(I)==="isoweek"?w?this.date(this.date()-(this.isoWeekday()-1)).startOf("day"):this.date(this.date()-1-(this.isoWeekday()-1)+7).endOf("day"):M.bind(this)(I,x)}}})})(se);var Ue=se.exports;const Ze=Ot(Ue);var ae={exports:{}};(function(t,e){(function(i,n){t.exports=n()})(Yt,function(){var i={LTS:"h:mm:ss A",LT:"h:mm A",L:"MM/DD/YYYY",LL:"MMMM D, YYYY",LLL:"MMMM D, YYYY h:mm A",LLLL:"dddd, MMMM D, YYYY h:mm A"},n=/(\[[^[]*\])|([-_:/.,()\s]+)|(A|a|Q|YYYY|YY?|ww?|MM?M?M?|Do|DD?|hh?|HH?|mm?|ss?|S{1,3}|z|ZZ?)/g,s=/\d/,k=/\d\d/,m=/\d\d?/,v=/\d*[^-_:/,()\s\d]+/,M={},I=function(h){return(h=+h)+(h>68?1900:2e3)},x=function(h){return function(A){this[h]=+A}},Y=[/[+-]\d\d:?(\d\d)?|Z/,function(h){(this.zone||(this.zone={})).offset=function(A){if(!A||A==="Z")return 0;var L=A.match(/([+-]|\d\d)/g),F=60*L[1]+(+L[2]||0);return F===0?0:L[0]==="+"?-F:F}(h)}],w=function(h){var A=M[h];return A&&(A.indexOf?A:A.s.concat(A.f))},b=function(h,A){var L,F=M.meridiem;if(F){for(var N=1;N<=24;N+=1)if(h.indexOf(F(N,0,A))>-1){L=N>12;break}}else L=h===(A?"pm":"PM");return L},Z={A:[v,function(h){this.afternoon=b(h,!1)}],a:[v,function(h){this.afternoon=b(h,!0)}],Q:[s,function(h){this.month=3*(h-1)+1}],S:[s,function(h){this.milliseconds=100*+h}],SS:[k,function(h){this.milliseconds=10*+h}],SSS:[/\d{3}/,function(h){this.milliseconds=+h}],s:[m,x("seconds")],ss:[m,x("seconds")],m:[m,x("minutes")],mm:[m,x("minutes")],H:[m,x("hours")],h:[m,x("hours")],HH:[m,x("hours")],hh:[m,x("hours")],D:[m,x("day")],DD:[k,x("day")],Do:[v,function(h){var A=M.ordinal,L=h.match(/\d+/);if(this.day=L[0],A)for(var F=1;F<=31;F+=1)A(F).replace(/\[|\]/g,"")===h&&(this.day=F)}],w:[m,x("week")],ww:[k,x("week")],M:[m,x("month")],MM:[k,x("month")],MMM:[v,function(h){var A=w("months"),L=(w("monthsShort")||A.map(function(F){return F.slice(0,3)})).indexOf(h)+1;if(L<1)throw new Error;this.month=L%12||L}],MMMM:[v,function(h){var A=w("months").indexOf(h)+1;if(A<1)throw new Error;this.month=A%12||A}],Y:[/[+-]?\d+/,x("year")],YY:[k,function(h){this.year=I(h)}],YYYY:[/\d{4}/,x("year")],Z:Y,ZZ:Y};function X(h){var A,L;A=h,L=M&&M.formats;for(var F=(h=A.replace(/(\[[^\]]+])|(LTS?|l{1,4}|L{1,4})/g,function(y,T,p){var g=p&&p.toUpperCase();return T||L[p]||i[p]||L[g].replace(/(\[[^\]]+])|(MMMM|MM|DD|dddd)/g,function(a,d,f){return d||f.slice(1)})})).match(n),N=F.length,P=0;P<N;P+=1){var j=F[P],V=Z[j],$=V&&V[0],B=V&&V[1];F[P]=B?{regex:$,parser:B}:j.replace(/^\[|\]$/g,"")}return function(y){for(var T={},p=0,g=0;p<N;p+=1){var a=F[p];if(typeof a=="string")g+=a.length;else{var d=a.regex,f=a.parser,u=y.slice(g),_=d.exec(u)[0];f.call(T,_),y=y.replace(_,"")}}return function(r){var D=r.afternoon;if(D!==void 0){var o=r.hours;D?o<12&&(r.hours+=12):o===12&&(r.hours=0),delete r.afternoon}}(T),T}}return function(h,A,L){L.p.customParseFormat=!0,h&&h.parseTwoDigitYear&&(I=h.parseTwoDigitYear);var F=A.prototype,N=F.parse;F.parse=function(P){var j=P.date,V=P.utc,$=P.args;this.$u=V;var B=$[1];if(typeof B=="string"){var y=$[2]===!0,T=$[3]===!0,p=y||T,g=$[2];T&&(g=$[2]),M=this.$locale(),!y&&g&&(M=L.Ls[g]),this.$d=function(u,_,r,D){try{if(["x","X"].indexOf(_)>-1)return new Date((_==="X"?1e3:1)*u);var o=X(_)(u),R=o.year,c=o.month,C=o.day,S=o.hours,W=o.minutes,E=o.seconds,z=o.milliseconds,O=o.zone,it=o.week,st=new Date,yt=C||(R||c?1:st.getDate()),lt=R||st.getFullYear(),H=0;R&&!c||(H=c>0?c-1:st.getMonth());var K,U=S||0,at=W||0,J=E||0,nt=z||0;return O?new Date(Date.UTC(lt,H,yt,U,at,J,nt+60*O.offset*1e3)):r?new Date(Date.UTC(lt,H,yt,U,at,J,nt)):(K=new Date(lt,H,yt,U,at,J,nt),it&&(K=D(K).week(it).toDate()),K)}catch{return new Date("")}}(j,B,V,L),this.init(),g&&g!==!0&&(this.$L=this.locale(g).$L),p&&j!=this.format(B)&&(this.$d=new Date("")),M={}}else if(B instanceof Array)for(var a=B.length,d=1;d<=a;d+=1){$[1]=B[d-1];var f=L.apply(this,$);if(f.isValid()){this.$d=f.$d,this.$L=f.$L,this.init();break}d===a&&(this.$d=new Date(""))}else N.call(this,P)}}})})(ae);var Qe=ae.exports;const Ke=Ot(Qe);var oe={exports:{}};(function(t,e){(function(i,n){t.exports=n()})(Yt,function(){return function(i,n){var s=n.prototype,k=s.format;s.format=function(m){var v=this,M=this.$locale();if(!this.isValid())return k.bind(this)(m);var I=this.$utils(),x=(m||"YYYY-MM-DDTHH:mm:ssZ").replace(/\[([^\]]+)]|Q|wo|ww|w|WW|W|zzz|z|gggg|GGGG|Do|X|x|k{1,2}|S/g,function(Y){switch(Y){case"Q":return Math.ceil((v.$M+1)/3);case"Do":return M.ordinal(v.$D);case"gggg":return v.weekYear();case"GGGG":return v.isoWeekYear();case"wo":return M.ordinal(v.week(),"W");case"w":case"ww":return I.s(v.week(),Y==="w"?1:2,"0");case"W":case"WW":return I.s(v.isoWeek(),Y==="W"?1:2,"0");case"k":case"kk":return I.s(String(v.$H===0?24:v.$H),Y==="k"?1:2,"0");case"X":return Math.floor(v.$d.getTime()/1e3);case"x":return v.$d.getTime();case"z":return"["+v.offsetName()+"]";case"zzz":return"["+v.offsetName("long")+"]";default:return Y}});return k.bind(this)(x)}}})})(oe);var Je=oe.exports;const tr=Ot(Je);var It=function(){var t=l(function(g,a,d,f){for(d=d||{},f=g.length;f--;d[g[f]]=a);return d},"o"),e=[6,8,10,12,13,14,15,16,17,18,20,21,22,23,24,25,26,27,28,29,30,31,33,35,36,38,40],i=[1,26],n=[1,27],s=[1,28],k=[1,29],m=[1,30],v=[1,31],M=[1,32],I=[1,33],x=[1,34],Y=[1,9],w=[1,10],b=[1,11],Z=[1,12],X=[1,13],h=[1,14],A=[1,15],L=[1,16],F=[1,19],N=[1,20],P=[1,21],j=[1,22],V=[1,23],$=[1,25],B=[1,35],y={trace:l(function(){},"trace"),yy:{},symbols_:{error:2,start:3,gantt:4,document:5,EOF:6,line:7,SPACE:8,statement:9,NL:10,weekday:11,weekday_monday:12,weekday_tuesday:13,weekday_wednesday:14,weekday_thursday:15,weekday_friday:16,weekday_saturday:17,weekday_sunday:18,weekend:19,weekend_friday:20,weekend_saturday:21,dateFormat:22,inclusiveEndDates:23,topAxis:24,axisFormat:25,tickInterval:26,excludes:27,includes:28,todayMarker:29,title:30,acc_title:31,acc_title_value:32,acc_descr:33,acc_descr_value:34,acc_descr_multiline_value:35,section:36,clickStatement:37,taskTxt:38,taskData:39,click:40,callbackname:41,callbackargs:42,href:43,clickStatementDebug:44,$accept:0,$end:1},terminals_:{2:"error",4:"gantt",6:"EOF",8:"SPACE",10:"NL",12:"weekday_monday",13:"weekday_tuesday",14:"weekday_wednesday",15:"weekday_thursday",16:"weekday_friday",17:"weekday_saturday",18:"weekday_sunday",20:"weekend_friday",21:"weekend_saturday",22:"dateFormat",23:"inclusiveEndDates",24:"topAxis",25:"axisFormat",26:"tickInterval",27:"excludes",28:"includes",29:"todayMarker",30:"title",31:"acc_title",32:"acc_title_value",33:"acc_descr",34:"acc_descr_value",35:"acc_descr_multiline_value",36:"section",38:"taskTxt",39:"taskData",40:"click",41:"callbackname",42:"callbackargs",43:"href"},productions_:[0,[3,3],[5,0],[5,2],[7,2],[7,1],[7,1],[7,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[19,1],[19,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,2],[9,1],[9,1],[9,1],[9,2],[37,2],[37,3],[37,3],[37,4],[37,3],[37,4],[37,2],[44,2],[44,3],[44,3],[44,4],[44,3],[44,4],[44,2]],performAction:l(function(a,d,f,u,_,r,D){var o=r.length-1;switch(_){case 1:return r[o-1];case 2:this.$=[];break;case 3:r[o-1].push(r[o]),this.$=r[o-1];break;case 4:case 5:this.$=r[o];break;case 6:case 7:this.$=[];break;case 8:u.setWeekday("monday");break;case 9:u.setWeekday("tuesday");break;case 10:u.setWeekday("wednesday");break;case 11:u.setWeekday("thursday");break;case 12:u.setWeekday("friday");break;case 13:u.setWeekday("saturday");break;case 14:u.setWeekday("sunday");break;case 15:u.setWeekend("friday");break;case 16:u.setWeekend("saturday");break;case 17:u.setDateFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 18:u.enableInclusiveEndDates(),this.$=r[o].substr(18);break;case 19:u.TopAxis(),this.$=r[o].substr(8);break;case 20:u.setAxisFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 21:u.setTickInterval(r[o].substr(13)),this.$=r[o].substr(13);break;case 22:u.setExcludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 23:u.setIncludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 24:u.setTodayMarker(r[o].substr(12)),this.$=r[o].substr(12);break;case 27:u.setDiagramTitle(r[o].substr(6)),this.$=r[o].substr(6);break;case 28:this.$=r[o].trim(),u.setAccTitle(this.$);break;case 29:case 30:this.$=r[o].trim(),u.setAccDescription(this.$);break;case 31:u.addSection(r[o].substr(8)),this.$=r[o].substr(8);break;case 33:u.addTask(r[o-1],r[o]),this.$="task";break;case 34:this.$=r[o-1],u.setClickEvent(r[o-1],r[o],null);break;case 35:this.$=r[o-2],u.setClickEvent(r[o-2],r[o-1],r[o]);break;case 36:this.$=r[o-2],u.setClickEvent(r[o-2],r[o-1],null),u.setLink(r[o-2],r[o]);break;case 37:this.$=r[o-3],u.setClickEvent(r[o-3],r[o-2],r[o-1]),u.setLink(r[o-3],r[o]);break;case 38:this.$=r[o-2],u.setClickEvent(r[o-2],r[o],null),u.setLink(r[o-2],r[o-1]);break;case 39:this.$=r[o-3],u.setClickEvent(r[o-3],r[o-1],r[o]),u.setLink(r[o-3],r[o-2]);break;case 40:this.$=r[o-1],u.setLink(r[o-1],r[o]);break;case 41:case 47:this.$=r[o-1]+" "+r[o];break;case 42:case 43:case 45:this.$=r[o-2]+" "+r[o-1]+" "+r[o];break;case 44:case 46:this.$=r[o-3]+" "+r[o-2]+" "+r[o-1]+" "+r[o];break}},"anonymous"),table:[{3:1,4:[1,2]},{1:[3]},t(e,[2,2],{5:3}),{6:[1,4],7:5,8:[1,6],9:7,10:[1,8],11:17,12:i,13:n,14:s,15:k,16:m,17:v,18:M,19:18,20:I,21:x,22:Y,23:w,24:b,25:Z,26:X,27:h,28:A,29:L,30:F,31:N,33:P,35:j,36:V,37:24,38:$,40:B},t(e,[2,7],{1:[2,1]}),t(e,[2,3]),{9:36,11:17,12:i,13:n,14:s,15:k,16:m,17:v,18:M,19:18,20:I,21:x,22:Y,23:w,24:b,25:Z,26:X,27:h,28:A,29:L,30:F,31:N,33:P,35:j,36:V,37:24,38:$,40:B},t(e,[2,5]),t(e,[2,6]),t(e,[2,17]),t(e,[2,18]),t(e,[2,19]),t(e,[2,20]),t(e,[2,21]),t(e,[2,22]),t(e,[2,23]),t(e,[2,24]),t(e,[2,25]),t(e,[2,26]),t(e,[2,27]),{32:[1,37]},{34:[1,38]},t(e,[2,30]),t(e,[2,31]),t(e,[2,32]),{39:[1,39]},t(e,[2,8]),t(e,[2,9]),t(e,[2,10]),t(e,[2,11]),t(e,[2,12]),t(e,[2,13]),t(e,[2,14]),t(e,[2,15]),t(e,[2,16]),{41:[1,40],43:[1,41]},t(e,[2,4]),t(e,[2,28]),t(e,[2,29]),t(e,[2,33]),t(e,[2,34],{42:[1,42],43:[1,43]}),t(e,[2,40],{41:[1,44]}),t(e,[2,35],{43:[1,45]}),t(e,[2,36]),t(e,[2,38],{42:[1,46]}),t(e,[2,37]),t(e,[2,39])],defaultActions:{},parseError:l(function(a,d){if(d.recoverable)this.trace(a);else{var f=new Error(a);throw f.hash=d,f}},"parseError"),parse:l(function(a){var d=this,f=[0],u=[],_=[null],r=[],D=this.table,o="",R=0,c=0,C=2,S=1,W=r.slice.call(arguments,1),E=Object.create(this.lexer),z={yy:{}};for(var O in this.yy)Object.prototype.hasOwnProperty.call(this.yy,O)&&(z.yy[O]=this.yy[O]);E.setInput(a,z.yy),z.yy.lexer=E,z.yy.parser=this,typeof E.yylloc>"u"&&(E.yylloc={});var it=E.yylloc;r.push(it);var st=E.options&&E.options.ranges;typeof z.yy.parseError=="function"?this.parseError=z.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function yt(Q){f.length=f.length-2*Q,_.length=_.length-Q,r.length=r.length-Q}l(yt,"popStack");function lt(){var Q;return Q=u.pop()||E.lex()||S,typeof Q!="number"&&(Q instanceof Array&&(u=Q,Q=u.pop()),Q=d.symbols_[Q]||Q),Q}l(lt,"lex");for(var H,K,U,at,J={},nt,tt,Xt,pt;;){if(K=f[f.length-1],this.defaultActions[K]?U=this.defaultActions[K]:((H===null||typeof H>"u")&&(H=lt()),U=D[K]&&D[K][H]),typeof U>"u"||!U.length||!U[0]){var Ct="";pt=[];for(nt in D[K])this.terminals_[nt]&&nt>C&&pt.push("'"+this.terminals_[nt]+"'");E.showPosition?Ct="Parse error on line "+(R+1)+`:
`+E.showPosition()+`
Expecting `+pt.join(", ")+", got '"+(this.terminals_[H]||H)+"'":Ct="Parse error on line "+(R+1)+": Unexpected "+(H==S?"end of input":"'"+(this.terminals_[H]||H)+"'"),this.parseError(Ct,{text:E.match,token:this.terminals_[H]||H,line:E.yylineno,loc:it,expected:pt})}if(U[0]instanceof Array&&U.length>1)throw new Error("Parse Error: multiple actions possible at state: "+K+", token: "+H);switch(U[0]){case 1:f.push(H),_.push(E.yytext),r.push(E.yylloc),f.push(U[1]),H=null,c=E.yyleng,o=E.yytext,R=E.yylineno,it=E.yylloc;break;case 2:if(tt=this.productions_[U[1]][1],J.$=_[_.length-tt],J._$={first_line:r[r.length-(tt||1)].first_line,last_line:r[r.length-1].last_line,first_column:r[r.length-(tt||1)].first_column,last_column:r[r.length-1].last_column},st&&(J._$.range=[r[r.length-(tt||1)].range[0],r[r.length-1].range[1]]),at=this.performAction.apply(J,[o,c,R,z.yy,U[1],_,r].concat(W)),typeof at<"u")return at;tt&&(f=f.slice(0,-1*tt*2),_=_.slice(0,-1*tt),r=r.slice(0,-1*tt)),f.push(this.productions_[U[1]][0]),_.push(J.$),r.push(J._$),Xt=D[f[f.length-2]][f[f.length-1]],f.push(Xt);break;case 3:return!0}}return!0},"parse")},T=function(){var g={EOF:1,parseError:l(function(d,f){if(this.yy.parser)this.yy.parser.parseError(d,f);else throw new Error(d)},"parseError"),setInput:l(function(a,d){return this.yy=d||this.yy||{},this._input=a,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:l(function(){var a=this._input[0];this.yytext+=a,this.yyleng++,this.offset++,this.match+=a,this.matched+=a;var d=a.match(/(?:\r\n?|\n).*/g);return d?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),a},"input"),unput:l(function(a){var d=a.length,f=a.split(/(?:\r\n?|\n)/g);this._input=a+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-d),this.offset-=d;var u=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),f.length-1&&(this.yylineno-=f.length-1);var _=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:f?(f.length===u.length?this.yylloc.first_column:0)+u[u.length-f.length].length-f[0].length:this.yylloc.first_column-d},this.options.ranges&&(this.yylloc.range=[_[0],_[0]+this.yyleng-d]),this.yyleng=this.yytext.length,this},"unput"),more:l(function(){return this._more=!0,this},"more"),reject:l(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:l(function(a){this.unput(this.match.slice(a))},"less"),pastInput:l(function(){var a=this.matched.substr(0,this.matched.length-this.match.length);return(a.length>20?"...":"")+a.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:l(function(){var a=this.match;return a.length<20&&(a+=this._input.substr(0,20-a.length)),(a.substr(0,20)+(a.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:l(function(){var a=this.pastInput(),d=new Array(a.length+1).join("-");return a+this.upcomingInput()+`
`+d+"^"},"showPosition"),test_match:l(function(a,d){var f,u,_;if(this.options.backtrack_lexer&&(_={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(_.yylloc.range=this.yylloc.range.slice(0))),u=a[0].match(/(?:\r\n?|\n).*/g),u&&(this.yylineno+=u.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:u?u[u.length-1].length-u[u.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+a[0].length},this.yytext+=a[0],this.match+=a[0],this.matches=a,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(a[0].length),this.matched+=a[0],f=this.performAction.call(this,this.yy,this,d,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),f)return f;if(this._backtrack){for(var r in _)this[r]=_[r];return!1}return!1},"test_match"),next:l(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var a,d,f,u;this._more||(this.yytext="",this.match="");for(var _=this._currentRules(),r=0;r<_.length;r++)if(f=this._input.match(this.rules[_[r]]),f&&(!d||f[0].length>d[0].length)){if(d=f,u=r,this.options.backtrack_lexer){if(a=this.test_match(f,_[r]),a!==!1)return a;if(this._backtrack){d=!1;continue}else return!1}else if(!this.options.flex)break}return d?(a=this.test_match(d,_[u]),a!==!1?a:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:l(function(){var d=this.next();return d||this.lex()},"lex"),begin:l(function(d){this.conditionStack.push(d)},"begin"),popState:l(function(){var d=this.conditionStack.length-1;return d>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:l(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:l(function(d){return d=this.conditionStack.length-1-Math.abs(d||0),d>=0?this.conditionStack[d]:"INITIAL"},"topState"),pushState:l(function(d){this.begin(d)},"pushState"),stateStackSize:l(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:l(function(d,f,u,_){switch(u){case 0:return this.begin("open_directive"),"open_directive";case 1:return this.begin("acc_title"),31;case 2:return this.popState(),"acc_title_value";case 3:return this.begin("acc_descr"),33;case 4:return this.popState(),"acc_descr_value";case 5:this.begin("acc_descr_multiline");break;case 6:this.popState();break;case 7:return"acc_descr_multiline_value";case 8:break;case 9:break;case 10:break;case 11:return 10;case 12:break;case 13:break;case 14:this.begin("href");break;case 15:this.popState();break;case 16:return 43;case 17:this.begin("callbackname");break;case 18:this.popState();break;case 19:this.popState(),this.begin("callbackargs");break;case 20:return 41;case 21:this.popState();break;case 22:return 42;case 23:this.begin("click");break;case 24:this.popState();break;case 25:return 40;case 26:return 4;case 27:return 22;case 28:return 23;case 29:return 24;case 30:return 25;case 31:return 26;case 32:return 28;case 33:return 27;case 34:return 29;case 35:return 12;case 36:return 13;case 37:return 14;case 38:return 15;case 39:return 16;case 40:return 17;case 41:return 18;case 42:return 20;case 43:return 21;case 44:return"date";case 45:return 30;case 46:return"accDescription";case 47:return 36;case 48:return 38;case 49:return 39;case 50:return":";case 51:return 6;case 52:return"INVALID"}},"anonymous"),rules:[/^(?:%%\{)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:%%(?!\{)*[^\n]*)/i,/^(?:[^\}]%%*[^\n]*)/i,/^(?:%%*[^\n]*[\n]*)/i,/^(?:[\n]+)/i,/^(?:\s+)/i,/^(?:%[^\n]*)/i,/^(?:href[\s]+["])/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:call[\s]+)/i,/^(?:\([\s]*\))/i,/^(?:\()/i,/^(?:[^(]*)/i,/^(?:\))/i,/^(?:[^)]*)/i,/^(?:click[\s]+)/i,/^(?:[\s\n])/i,/^(?:[^\s\n]*)/i,/^(?:gantt\b)/i,/^(?:dateFormat\s[^#\n;]+)/i,/^(?:inclusiveEndDates\b)/i,/^(?:topAxis\b)/i,/^(?:axisFormat\s[^#\n;]+)/i,/^(?:tickInterval\s[^#\n;]+)/i,/^(?:includes\s[^#\n;]+)/i,/^(?:excludes\s[^#\n;]+)/i,/^(?:todayMarker\s[^\n;]+)/i,/^(?:weekday\s+monday\b)/i,/^(?:weekday\s+tuesday\b)/i,/^(?:weekday\s+wednesday\b)/i,/^(?:weekday\s+thursday\b)/i,/^(?:weekday\s+friday\b)/i,/^(?:weekday\s+saturday\b)/i,/^(?:weekday\s+sunday\b)/i,/^(?:weekend\s+friday\b)/i,/^(?:weekend\s+saturday\b)/i,/^(?:\d\d\d\d-\d\d-\d\d\b)/i,/^(?:title\s[^\n]+)/i,/^(?:accDescription\s[^#\n;]+)/i,/^(?:section\s[^\n]+)/i,/^(?:[^:\n]+)/i,/^(?::[^#\n;]+)/i,/^(?::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{acc_descr_multiline:{rules:[6,7],inclusive:!1},acc_descr:{rules:[4],inclusive:!1},acc_title:{rules:[2],inclusive:!1},callbackargs:{rules:[21,22],inclusive:!1},callbackname:{rules:[18,19,20],inclusive:!1},href:{rules:[15,16],inclusive:!1},click:{rules:[24,25],inclusive:!1},INITIAL:{rules:[0,1,3,5,8,9,10,11,12,13,14,17,23,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52],inclusive:!0}}};return g}();y.lexer=T;function p(){this.yy={}}return l(p,"Parser"),p.prototype=y,y.Parser=p,new p}();It.parser=It;var er=It;q.extend(Ze);q.extend(Ke);q.extend(tr);var ee={friday:5,saturday:6},et="",Wt="",Vt=void 0,zt="",ht=[],mt=[],Pt=new Map,Rt=[],_t=[],kt="",Nt="",ce=["active","done","crit","milestone","vert"],Bt=[],ut="",gt=!1,$t=!1,Ht="sunday",Dt="saturday",At=0,rr=l(function(){Rt=[],_t=[],kt="",Bt=[],bt=0,Ft=void 0,wt=void 0,G=[],et="",Wt="",Nt="",Vt=void 0,zt="",ht=[],mt=[],gt=!1,$t=!1,At=0,Pt=new Map,ut="",Ce(),Ht="sunday",Dt="saturday"},"clear"),ir=l(function(t){ut=t},"setDiagramId"),nr=l(function(t){Wt=t},"setAxisFormat"),sr=l(function(){return Wt},"getAxisFormat"),ar=l(function(t){Vt=t},"setTickInterval"),or=l(function(){return Vt},"getTickInterval"),cr=l(function(t){zt=t},"setTodayMarker"),lr=l(function(){return zt},"getTodayMarker"),ur=l(function(t){et=t},"setDateFormat"),dr=l(function(){gt=!0},"enableInclusiveEndDates"),fr=l(function(){return gt},"endDatesAreInclusive"),hr=l(function(){$t=!0},"enableTopAxis"),mr=l(function(){return $t},"topAxisEnabled"),kr=l(function(t){Nt=t},"setDisplayMode"),yr=l(function(){return Nt},"getDisplayMode"),gr=l(function(){return et},"getDateFormat"),le=l((t,e)=>{const i=e.toLowerCase().split(/[\s,]+/).filter(n=>n!=="");return[...new Set([...t,...i])]},"mergeTokens"),pr=l(function(t){ht=le(ht,t)},"setIncludes"),vr=l(function(){return ht},"getIncludes"),xr=l(function(t){mt=le(mt,t)},"setExcludes"),Tr=l(function(){return mt},"getExcludes"),br=l(function(){return Pt},"getLinks"),wr=l(function(t){kt=t,Rt.push(t)},"addSection"),_r=l(function(){return Rt},"getSections"),Dr=l(function(){let t=re();const e=10;let i=0;for(;!t&&i<e;)t=re(),i++;return _t=G,_t},"getTasks"),ue=l(function(t,e,i,n){const s=t.format(e.trim()),k=t.format("YYYY-MM-DD");return n.includes(s)||n.includes(k)?!1:i.includes("weekends")&&(t.isoWeekday()===ee[Dt]||t.isoWeekday()===ee[Dt]+1)||i.includes(t.format("dddd").toLowerCase())?!0:i.includes(s)||i.includes(k)},"isInvalidDate"),Cr=l(function(t){Ht=t},"setWeekday"),Sr=l(function(){return Ht},"getWeekday"),Er=l(function(t){Dt=t},"setWeekend"),de=l(function(t,e,i,n){if(!i.length||t.manualEndTime)return;let s;t.startTime instanceof Date?s=q(t.startTime):s=q(t.startTime,e,!0),s=s.add(1,"d");let k;t.endTime instanceof Date?k=q(t.endTime):k=q(t.endTime,e,!0);const[m,v]=Mr(s,k,e,i,n);t.endTime=m.toDate(),t.renderEndTime=v},"checkTaskDates"),Mr=l(function(t,e,i,n,s){let k=!1,m=null;const v=e.add(1e4,"d");for(;t<=e;){if(k||(m=e.toDate()),k=ue(t,i,n,s),k&&(e=e.add(1,"d"),e>v))throw new Error("Failed to find a valid date that was not excluded by `excludes` after 10,000 iterations.");t=t.add(1,"d")}return[e,m]},"fixTaskDates"),Lt=l(function(t,e,i){if(i=i.trim(),l(v=>{const M=v.trim();return M==="x"||M==="X"},"isTimestampFormat")(e)&&/^\d+$/.test(i))return new Date(Number(i));const k=/^after\s+(?<ids>[\d\w- ]+)/.exec(i);if(k!==null){let v=null;for(const I of k.groups.ids.split(" ")){let x=ct(I);x!==void 0&&(!v||x.endTime>v.endTime)&&(v=x)}if(v)return v.endTime;const M=new Date;return M.setHours(0,0,0,0),M}let m=q(i,e.trim(),!0);if(m.isValid())return m.toDate();{ot.debug("Invalid date:"+i),ot.debug("With date format:"+e.trim());const v=new Date(i);if(v===void 0||isNaN(v.getTime())||v.getFullYear()<-1e4||v.getFullYear()>1e4)throw new Error("Invalid date:"+i);return v}},"getStartDate"),fe=l(function(t){const e=/^(\d+(?:\.\d+)?)([Mdhmswy]|ms)$/.exec(t.trim());return e!==null?[Number.parseFloat(e[1]),e[2]]:[NaN,"ms"]},"parseDuration"),he=l(function(t,e,i,n=!1){i=i.trim();const k=/^until\s+(?<ids>[\d\w- ]+)/.exec(i);if(k!==null){let x=null;for(const w of k.groups.ids.split(" ")){let b=ct(w);b!==void 0&&(!x||b.startTime<x.startTime)&&(x=b)}if(x)return x.startTime;const Y=new Date;return Y.setHours(0,0,0,0),Y}let m=q(i,e.trim(),!0);if(m.isValid())return n&&(m=m.add(1,"d")),m.toDate();let v=q(t);const[M,I]=fe(i);if(!Number.isNaN(M)){const x=v.add(M,I);x.isValid()&&(v=x)}return v.toDate()},"getEndDate"),bt=0,ft=l(function(t){return t===void 0?(bt=bt+1,"task"+bt):t},"parseId"),Ir=l(function(t,e){let i;e.substr(0,1)===":"?i=e.substr(1,e.length):i=e;const n=i.split(","),s={};Gt(n,s,ce);for(let m=0;m<n.length;m++)n[m]=n[m].trim();let k="";switch(n.length){case 1:s.id=ft(),s.startTime=t.endTime,k=n[0];break;case 2:s.id=ft(),s.startTime=Lt(void 0,et,n[0]),k=n[1];break;case 3:s.id=ft(n[0]),s.startTime=Lt(void 0,et,n[1]),k=n[2];break}return k&&(s.endTime=he(s.startTime,et,k,gt),s.manualEndTime=q(k,"YYYY-MM-DD",!0).isValid(),de(s,et,mt,ht)),s},"compileData"),Ar=l(function(t,e){let i;e.substr(0,1)===":"?i=e.substr(1,e.length):i=e;const n=i.split(","),s={};Gt(n,s,ce);for(let k=0;k<n.length;k++)n[k]=n[k].trim();switch(n.length){case 1:s.id=ft(),s.startTime={type:"prevTaskEnd",id:t},s.endTime={data:n[0]};break;case 2:s.id=ft(),s.startTime={type:"getStartDate",startData:n[0]},s.endTime={data:n[1]};break;case 3:s.id=ft(n[0]),s.startTime={type:"getStartDate",startData:n[1]},s.endTime={data:n[2]};break}return s},"parseData"),Ft,wt,G=[],me={},Lr=l(function(t,e){const i={section:kt,type:kt,processed:!1,manualEndTime:!1,renderEndTime:null,raw:{data:e},task:t,classes:[]},n=Ar(wt,e);i.raw.startTime=n.startTime,i.raw.endTime=n.endTime,i.id=n.id,i.prevTaskId=wt,i.active=n.active,i.done=n.done,i.crit=n.crit,i.milestone=n.milestone,i.vert=n.vert,i.vert?i.order=-1:(i.order=At,At++);const s=G.push(i);wt=i.id,me[i.id]=s-1},"addTask"),ct=l(function(t){const e=me[t];return G[e]},"findTaskById"),Fr=l(function(t,e){const i={section:kt,type:kt,description:t,task:t,classes:[]},n=Ir(Ft,e);i.startTime=n.startTime,i.endTime=n.endTime,i.id=n.id,i.active=n.active,i.done=n.done,i.crit=n.crit,i.milestone=n.milestone,i.vert=n.vert,Ft=i,_t.push(i)},"addTaskOrg"),re=l(function(){const t=l(function(i){const n=G[i];let s="";switch(G[i].raw.startTime.type){case"prevTaskEnd":{const k=ct(n.prevTaskId);n.startTime=k.endTime;break}case"getStartDate":s=Lt(void 0,et,G[i].raw.startTime.startData),s&&(G[i].startTime=s);break}return G[i].startTime&&(G[i].endTime=he(G[i].startTime,et,G[i].raw.endTime.data,gt),G[i].endTime&&(G[i].processed=!0,G[i].manualEndTime=q(G[i].raw.endTime.data,"YYYY-MM-DD",!0).isValid(),de(G[i],et,mt,ht))),G[i].processed},"compileTask");let e=!0;for(const[i,n]of G.entries())t(i),e=e&&n.processed;return e},"compileTasks"),Yr=l(function(t,e){let i=e;dt().securityLevel!=="loose"&&(i=De(e)),t.split(",").forEach(function(n){ct(n)!==void 0&&(ye(n,()=>{window.open(i,"_self")}),Pt.set(n,i))}),ke(t,"clickable")},"setLink"),ke=l(function(t,e){t.split(",").forEach(function(i){let n=ct(i);n!==void 0&&n.classes.push(e)})},"setClass"),Or=l(function(t,e,i){if(dt().securityLevel!=="loose"||e===void 0)return;let n=[];if(typeof i=="string"){n=i.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);for(let k=0;k<n.length;k++){let m=n[k].trim();m.startsWith('"')&&m.endsWith('"')&&(m=m.substr(1,m.length-2)),n[k]=m}}n.length===0&&n.push(t),ct(t)!==void 0&&ye(t,()=>{Se.runFunc(e,...n)})},"setClickFun"),ye=l(function(t,e){Bt.push(function(){const i=ut?`${ut}-${t}`:t,n=document.querySelector(`[id="${i}"]`);n!==null&&n.addEventListener("click",function(){e()})},function(){const i=ut?`${ut}-${t}`:t,n=document.querySelector(`[id="${i}-text"]`);n!==null&&n.addEventListener("click",function(){e()})})},"pushFun"),Wr=l(function(t,e,i){t.split(",").forEach(function(n){Or(n,e,i)}),ke(t,"clickable")},"setClickEvent"),Vr=l(function(t){Bt.forEach(function(e){e(t)})},"bindFunctions"),zr={getConfig:l(()=>dt().gantt,"getConfig"),clear:rr,setDateFormat:ur,getDateFormat:gr,enableInclusiveEndDates:dr,endDatesAreInclusive:fr,enableTopAxis:hr,topAxisEnabled:mr,setAxisFormat:nr,getAxisFormat:sr,setTickInterval:ar,getTickInterval:or,setTodayMarker:cr,getTodayMarker:lr,setAccTitle:be,getAccTitle:Te,setDiagramTitle:xe,getDiagramTitle:ve,setDiagramId:ir,setDisplayMode:kr,getDisplayMode:yr,setAccDescription:pe,getAccDescription:ge,addSection:wr,getSections:_r,getTasks:Dr,addTask:Lr,findTaskById:ct,addTaskOrg:Fr,setIncludes:pr,getIncludes:vr,setExcludes:xr,getExcludes:Tr,setClickEvent:Wr,setLink:Yr,getLinks:br,bindFunctions:Vr,parseDuration:fe,isInvalidDate:ue,setWeekday:Cr,getWeekday:Sr,setWeekend:Er};function Gt(t,e,i){let n=!0;for(;n;)n=!1,i.forEach(function(s){const k="^\\s*"+s+"\\s*$",m=new RegExp(k);t[0].match(m)&&(e[s]=!0,t.shift(1),n=!0)})}l(Gt,"getTaskTags");q.extend(Ee);var Pr=l(function(){ot.debug("Something is calling, setConf, remove the call")},"setConf"),ie={monday:Pe,tuesday:ze,wednesday:Ve,thursday:We,friday:Oe,saturday:Ye,sunday:Fe},Rr=l((t,e)=>{let i=[...t].map(()=>-1/0),n=[...t].sort((k,m)=>k.startTime-m.startTime||k.order-m.order),s=0;for(const k of n)for(let m=0;m<i.length;m++)if(k.startTime>=i[m]){i[m]=k.endTime,k.order=m+e,m>s&&(s=m);break}return s},"getMaxIntersections"),rt,Et=1e4,Nr=l(function(t,e,i,n){const s=dt().gantt;n.db.setDiagramId(e);const k=dt().securityLevel;let m;k==="sandbox"&&(m=vt("#i"+e));const v=k==="sandbox"?vt(m.nodes()[0].contentDocument.body):vt("body"),M=k==="sandbox"?m.nodes()[0].contentDocument:document,I=M.getElementById(e);rt=I.parentElement.offsetWidth,rt===void 0&&(rt=1200),s.useWidth!==void 0&&(rt=s.useWidth);const x=n.db.getTasks(),Y=x.filter(y=>!y.vert);let w=[];for(const y of Y)w.push(y.type);w=B(w);const b={};let Z=2*s.topPadding;if(n.db.getDisplayMode()==="compact"||s.displayMode==="compact"){const y={};for(const p of Y)y[p.section]===void 0?y[p.section]=[p]:y[p.section].push(p);let T=0;for(const p of Object.keys(y)){const g=Rr(y[p],T)+1;T+=g,Z+=g*(s.barHeight+s.barGap),b[p]=g}}else{Z+=Y.length*(s.barHeight+s.barGap);for(const y of w)b[y]=Y.filter(T=>T.type===y).length}I.setAttribute("viewBox","0 0 "+rt+" "+Z);const X=v.select(`[id="${e}"]`),h=Me().domain([Ie(x,function(y){return y.startTime}),Ae(x,function(y){return y.endTime})]).rangeRound([0,rt-s.leftPadding-s.rightPadding]);function A(y,T){const p=y.startTime,g=T.startTime;let a=0;return p>g?a=1:p<g&&(a=-1),a}l(A,"taskCompare"),x.sort(A),L(x,rt,Z),we(X,Z,rt,s.useMaxWidth),X.append("text").text(n.db.getDiagramTitle()).attr("x",rt/2).attr("y",s.titleTopMargin).attr("class","titleText");function L(y,T,p){const g=s.barHeight,a=g+s.barGap,d=s.topPadding,f=s.leftPadding,u=Re().domain([0,w.length]).range(["#00B9FA","#F95002"]).interpolate(Le);N(a,d,f,T,p,y,n.db.getExcludes(),n.db.getIncludes()),j(f,d,T,p),F(y,a,d,f,g,u,T),V(a,d),$(f,d,T,p)}l(L,"makeGantt");function F(y,T,p,g,a,d,f){y.sort((c,C)=>c.vert===C.vert?0:c.vert?1:-1);const u=y.filter(c=>!c.vert),r=[...new Set(u.map(c=>c.order))].map(c=>u.find(C=>C.order===c));X.append("g").selectAll("rect").data(r).enter().append("rect").attr("x",0).attr("y",function(c,C){return C=c.order,C*T+p-2}).attr("width",function(){return f-s.rightPadding/2}).attr("height",T).attr("class",function(c){for(const[C,S]of w.entries())if(c.type===S)return"section section"+C%s.numberSectionStyles;return"section section0"}).enter();const D=X.append("g").selectAll("rect").data(y).enter(),o=n.db.getLinks();if(D.append("rect").attr("id",function(c){return e+"-"+c.id}).attr("rx",3).attr("ry",3).attr("x",function(c){return c.milestone?h(c.startTime)+g+.5*(h(c.endTime)-h(c.startTime))-.5*a:h(c.startTime)+g}).attr("y",function(c,C){return C=c.order,c.vert?s.gridLineStartPadding:C*T+p}).attr("width",function(c){return c.milestone?a:c.vert?.08*a:h(c.renderEndTime||c.endTime)-h(c.startTime)}).attr("height",function(c){return c.vert?u.length*(s.barHeight+s.barGap)+s.barHeight*2:a}).attr("transform-origin",function(c,C){return C=c.order,(h(c.startTime)+g+.5*(h(c.endTime)-h(c.startTime))).toString()+"px "+(C*T+p+.5*a).toString()+"px"}).attr("class",function(c){const C="task";let S="";c.classes.length>0&&(S=c.classes.join(" "));let W=0;for(const[z,O]of w.entries())c.type===O&&(W=z%s.numberSectionStyles);let E="";return c.active?c.crit?E+=" activeCrit":E=" active":c.done?c.crit?E=" doneCrit":E=" done":c.crit&&(E+=" crit"),E.length===0&&(E=" task"),c.milestone&&(E=" milestone "+E),c.vert&&(E=" vert "+E),E+=W,E+=" "+S,C+E}),D.append("text").attr("id",function(c){return e+"-"+c.id+"-text"}).text(function(c){return c.task}).attr("font-size",s.fontSize).attr("x",function(c){let C=h(c.startTime),S=h(c.renderEndTime||c.endTime);if(c.milestone&&(C+=.5*(h(c.endTime)-h(c.startTime))-.5*a,S=C+a),c.vert)return h(c.startTime)+g;const W=this.getBBox().width;return W>S-C?S+W+1.5*s.leftPadding>f?C+g-5:S+g+5:(S-C)/2+C+g}).attr("y",function(c,C){return c.vert?s.gridLineStartPadding+u.length*(s.barHeight+s.barGap)+60:(C=c.order,C*T+s.barHeight/2+(s.fontSize/2-2)+p)}).attr("text-height",a).attr("class",function(c){const C=h(c.startTime);let S=h(c.endTime);c.milestone&&(S=C+a);const W=this.getBBox().width;let E="";c.classes.length>0&&(E=c.classes.join(" "));let z=0;for(const[it,st]of w.entries())c.type===st&&(z=it%s.numberSectionStyles);let O="";return c.active&&(c.crit?O="activeCritText"+z:O="activeText"+z),c.done?c.crit?O=O+" doneCritText"+z:O=O+" doneText"+z:c.crit&&(O=O+" critText"+z),c.milestone&&(O+=" milestoneText"),c.vert&&(O+=" vertText"),W>S-C?S+W+1.5*s.leftPadding>f?E+" taskTextOutsideLeft taskTextOutside"+z+" "+O:E+" taskTextOutsideRight taskTextOutside"+z+" "+O+" width-"+W:E+" taskText taskText"+z+" "+O+" width-"+W}),dt().securityLevel==="sandbox"){let c;c=vt("#i"+e);const C=c.nodes()[0].contentDocument;D.filter(function(S){return o.has(S.id)}).each(function(S){var W=C.querySelector("#"+CSS.escape(e+"-"+S.id)),E=C.querySelector("#"+CSS.escape(e+"-"+S.id+"-text"));const z=W.parentNode;var O=C.createElement("a");O.setAttribute("xlink:href",o.get(S.id)),O.setAttribute("target","_top"),z.appendChild(O),O.appendChild(W),O.appendChild(E)})}}l(F,"drawRects");function N(y,T,p,g,a,d,f,u){if(f.length===0&&u.length===0)return;let _,r;for(const{startTime:S,endTime:W}of d)(_===void 0||S<_)&&(_=S),(r===void 0||W>r)&&(r=W);if(!_||!r)return;if(q(r).diff(q(_),"year")>5){ot.warn("The difference between the min and max time is more than 5 years. This will cause performance issues. Skipping drawing exclude days.");return}const D=n.db.getDateFormat(),o=[];let R=null,c=q(_);for(;c.valueOf()<=r;)n.db.isInvalidDate(c,D,f,u)?R?R.end=c:R={start:c,end:c}:R&&(o.push(R),R=null),c=c.add(1,"d");X.append("g").selectAll("rect").data(o).enter().append("rect").attr("id",S=>e+"-exclude-"+S.start.format("YYYY-MM-DD")).attr("x",S=>h(S.start.startOf("day"))+p).attr("y",s.gridLineStartPadding).attr("width",S=>h(S.end.endOf("day"))-h(S.start.startOf("day"))).attr("height",a-T-s.gridLineStartPadding).attr("transform-origin",function(S,W){return(h(S.start)+p+.5*(h(S.end)-h(S.start))).toString()+"px "+(W*y+.5*a).toString()+"px"}).attr("class","exclude-range")}l(N,"drawExcludeDays");function P(y,T,p,g){if(p<=0||y>T)return 1/0;const a=T-y,d=q.duration({[g??"day"]:p}).asMilliseconds();return d<=0?1/0:Math.ceil(a/d)}l(P,"getEstimatedTickCount");function j(y,T,p,g){const a=n.db.getDateFormat(),d=n.db.getAxisFormat();let f;d?f=d:a==="D"?f="%d":f=s.axisFormat??"%Y-%m-%d";let u=qe(h).tickSize(-g+T+s.gridLineStartPadding).tickFormat(jt(f));const r=/^([1-9]\d*)(millisecond|second|minute|hour|day|week|month)$/.exec(n.db.getTickInterval()||s.tickInterval);if(r!==null){const D=parseInt(r[1],10);if(isNaN(D)||D<=0)ot.warn(`Invalid tick interval value: "${r[1]}". Skipping custom tick interval.`);else{const o=r[2],R=n.db.getWeekday()||s.weekday,c=h.domain(),C=c[0],S=c[1],W=P(C,S,D,o);if(W>Et)ot.warn(`The tick interval "${D}${o}" would generate ${W} ticks, which exceeds the maximum allowed (${Et}). This may indicate an invalid date or time range. Skipping custom tick interval.`);else switch(o){case"millisecond":u.ticks(Jt.every(D));break;case"second":u.ticks(Kt.every(D));break;case"minute":u.ticks(Qt.every(D));break;case"hour":u.ticks(Zt.every(D));break;case"day":u.ticks(Ut.every(D));break;case"week":u.ticks(ie[R].every(D));break;case"month":u.ticks(qt.every(D));break}}}if(X.append("g").attr("class","grid").attr("transform","translate("+y+", "+(g-50)+")").call(u).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10).attr("dy","1em"),n.db.topAxisEnabled()||s.topAxis){let D=je(h).tickSize(-g+T+s.gridLineStartPadding).tickFormat(jt(f));if(r!==null){const o=parseInt(r[1],10);if(isNaN(o)||o<=0)ot.warn(`Invalid tick interval value: "${r[1]}". Skipping custom tick interval.`);else{const R=r[2],c=n.db.getWeekday()||s.weekday,C=h.domain(),S=C[0],W=C[1];if(P(S,W,o,R)<=Et)switch(R){case"millisecond":D.ticks(Jt.every(o));break;case"second":D.ticks(Kt.every(o));break;case"minute":D.ticks(Qt.every(o));break;case"hour":D.ticks(Zt.every(o));break;case"day":D.ticks(Ut.every(o));break;case"week":D.ticks(ie[c].every(o));break;case"month":D.ticks(qt.every(o));break}}}X.append("g").attr("class","grid").attr("transform","translate("+y+", "+T+")").call(D).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10)}}l(j,"makeGrid");function V(y,T){let p=0;const g=Object.keys(b).map(a=>[a,b[a]]);X.append("g").selectAll("text").data(g).enter().append(function(a){const d=a[0].split(_e.lineBreakRegex),f=-(d.length-1)/2,u=M.createElementNS("http://www.w3.org/2000/svg","text");u.setAttribute("dy",f+"em");for(const[_,r]of d.entries()){const D=M.createElementNS("http://www.w3.org/2000/svg","tspan");D.setAttribute("alignment-baseline","central"),D.setAttribute("x","10"),_>0&&D.setAttribute("dy","1em"),D.textContent=r,u.appendChild(D)}return u}).attr("x",10).attr("y",function(a,d){if(d>0)for(let f=0;f<d;f++)return p+=g[d-1][1],a[1]*y/2+p*y+T;else return a[1]*y/2+T}).attr("font-size",s.sectionFontSize).attr("class",function(a){for(const[d,f]of w.entries())if(a[0]===f)return"sectionTitle sectionTitle"+d%s.numberSectionStyles;return"sectionTitle"})}l(V,"vertLabels");function $(y,T,p,g){const a=n.db.getTodayMarker();if(a==="off")return;const d=X.append("g").attr("class","today"),f=new Date,u=d.append("line");u.attr("x1",h(f)+y).attr("x2",h(f)+y).attr("y1",s.titleTopMargin).attr("y2",g-s.titleTopMargin).attr("class","today"),a!==""&&u.attr("style",a.replace(/,/g,";"))}l($,"drawToday");function B(y){const T={},p=[];for(let g=0,a=y.length;g<a;++g)Object.prototype.hasOwnProperty.call(T,y[g])||(T[y[g]]=!0,p.push(y[g]));return p}l(B,"checkUnique")},"draw"),Br={setConf:Pr,draw:Nr},$r=l(t=>`
  .mermaid-main-font {
        font-family: ${t.fontFamily};
  }

  .exclude-range {
    fill: ${t.excludeBkgColor};
  }

  .section {
    stroke: none;
    opacity: 0.2;
  }

  .section0 {
    fill: ${t.sectionBkgColor};
  }

  .section2 {
    fill: ${t.sectionBkgColor2};
  }

  .section1,
  .section3 {
    fill: ${t.altSectionBkgColor};
    opacity: 0.2;
  }

  .sectionTitle0 {
    fill: ${t.titleColor};
  }

  .sectionTitle1 {
    fill: ${t.titleColor};
  }

  .sectionTitle2 {
    fill: ${t.titleColor};
  }

  .sectionTitle3 {
    fill: ${t.titleColor};
  }

  .sectionTitle {
    text-anchor: start;
    font-family: ${t.fontFamily};
  }


  /* Grid and axis */

  .grid .tick {
    stroke: ${t.gridColor};
    opacity: 0.8;
    shape-rendering: crispEdges;
  }

  .grid .tick text {
    font-family: ${t.fontFamily};
    fill: ${t.textColor};
  }

  .grid path {
    stroke-width: 0;
  }


  /* Today line */

  .today {
    fill: none;
    stroke: ${t.todayLineColor};
    stroke-width: 2px;
  }


  /* Task styling */

  /* Default task */

  .task {
    stroke-width: 2;
  }

  .taskText {
    text-anchor: middle;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideRight {
    fill: ${t.taskTextDarkColor};
    text-anchor: start;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideLeft {
    fill: ${t.taskTextDarkColor};
    text-anchor: end;
  }


  /* Special case clickable */

  .task.clickable {
    cursor: pointer;
  }

  .taskText.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideLeft.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideRight.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }


  /* Specific task settings for the sections*/

  .taskText0,
  .taskText1,
  .taskText2,
  .taskText3 {
    fill: ${t.taskTextColor};
  }

  .task0,
  .task1,
  .task2,
  .task3 {
    fill: ${t.taskBkgColor};
    stroke: ${t.taskBorderColor};
  }

  .taskTextOutside0,
  .taskTextOutside2
  {
    fill: ${t.taskTextOutsideColor};
  }

  .taskTextOutside1,
  .taskTextOutside3 {
    fill: ${t.taskTextOutsideColor};
  }


  /* Active task */

  .active0,
  .active1,
  .active2,
  .active3 {
    fill: ${t.activeTaskBkgColor};
    stroke: ${t.activeTaskBorderColor};
  }

  .activeText0,
  .activeText1,
  .activeText2,
  .activeText3 {
    fill: ${t.taskTextDarkColor} !important;
  }


  /* Completed task */

  .done0,
  .done1,
  .done2,
  .done3 {
    stroke: ${t.doneTaskBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
  }

  .doneText0,
  .doneText1,
  .doneText2,
  .doneText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  /* Done task text displayed outside the bar sits against the diagram background,
     not against the done-task bar, so it must use the outside/contrast color. */
  .doneText0.taskTextOutsideLeft,
  .doneText0.taskTextOutsideRight,
  .doneText1.taskTextOutsideLeft,
  .doneText1.taskTextOutsideRight,
  .doneText2.taskTextOutsideLeft,
  .doneText2.taskTextOutsideRight,
  .doneText3.taskTextOutsideLeft,
  .doneText3.taskTextOutsideRight {
    fill: ${t.taskTextOutsideColor} !important;
  }


  /* Tasks on the critical line */

  .crit0,
  .crit1,
  .crit2,
  .crit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.critBkgColor};
    stroke-width: 2;
  }

  .activeCrit0,
  .activeCrit1,
  .activeCrit2,
  .activeCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.activeTaskBkgColor};
    stroke-width: 2;
  }

  .doneCrit0,
  .doneCrit1,
  .doneCrit2,
  .doneCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
    cursor: pointer;
    shape-rendering: crispEdges;
  }

  .milestone {
    transform: rotate(45deg) scale(0.8,0.8);
  }

  .milestoneText {
    font-style: italic;
  }
  .doneCritText0,
  .doneCritText1,
  .doneCritText2,
  .doneCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  /* Done-crit task text outside the bar — same reasoning as doneText above. */
  .doneCritText0.taskTextOutsideLeft,
  .doneCritText0.taskTextOutsideRight,
  .doneCritText1.taskTextOutsideLeft,
  .doneCritText1.taskTextOutsideRight,
  .doneCritText2.taskTextOutsideLeft,
  .doneCritText2.taskTextOutsideRight,
  .doneCritText3.taskTextOutsideLeft,
  .doneCritText3.taskTextOutsideRight {
    fill: ${t.taskTextOutsideColor} !important;
  }

  .vert {
    stroke: ${t.vertLineColor};
  }

  .vertText {
    font-size: 15px;
    text-anchor: middle;
    fill: ${t.vertLineColor} !important;
  }

  .activeCritText0,
  .activeCritText1,
  .activeCritText2,
  .activeCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  .titleText {
    text-anchor: middle;
    font-size: 18px;
    fill: ${t.titleColor||t.textColor};
    font-family: ${t.fontFamily};
  }
`,"getStyles"),Hr=$r,Qr={parser:er,db:zr,renderer:Br,styles:Hr};export{Qr as diagram};
//# sourceMappingURL=YtsspSLo.js.map
