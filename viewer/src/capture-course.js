export function captureCourseInfo(page=document){
  const header=page.querySelector?.('.course_info_wrap .course_name');
  const title=(header?.getAttribute('title')||header?.textContent||page.title||'').replace(/\s*\[ZJF:[a-f0-9]+\]/g,'').replace(/\s*[-|·]\s*智云课堂.*$/,'').trim();
  const teacher=page.querySelector?.('.course_info_wrap .teacher_span')?.textContent?.trim()||'';
  const school=header||/(?:^|\.)zju\.edu\.cn$/.test(page.location?.hostname||'')?'浙江大学':'';
  return {school,course:title==='智云课堂'?'':title.slice(0,160),teacher:teacher.slice(0,60)};
}
