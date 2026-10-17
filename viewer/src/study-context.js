// Classroom identity comes from the platform IDs, never the current chat text.
export function studyLessonScope(key='') {
  const match=/^__zjf_layout_v1:(\d{1,12}):(\d{1,12}):(\d{1,12})(?::|$)/.exec(key);
  return match?'__zjf_layout_v1:'+match.slice(1).join(':'):String(key||'');
}
export function studyCourseScope(key='',course={}) {
  const match=/^__zjf_layout_v1:(\d{1,12}):(\d{1,12}):/.exec(key);
  return match?'zjf-course:'+match.slice(1).join(':'):course.course?'name:'+studyCourseName(course):'unclassified';
}
export function studyCourseName(course={}) {
  const name=(course.course||'').replace(/\s*\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?.*$/,'').trim();
  return !name||['板书提问','课后提问','未命名提问'].includes(name)?'未归类':name;
}
export function studyLessonName(course={},key='') {
  const title=course.course||'',name=studyCourseName(course),detail=name==='未归类'?'':title.slice(title.startsWith(name)?name.length:0).trim();
  return detail||(/:(\d+)$/.exec(studyLessonScope(key))?.[1]?'讲次 '+/:(\d+)$/.exec(studyLessonScope(key))[1]:'未归类讲次');
}

export function studyRecordContext(record={}) {
  const manifest=record.draftManifest||{},key=record.lessonKey??manifest.viewerLessonKey??manifest.draft?.lessonKey??'';
  const course=record.course??manifest.viewerCourse??manifest.draft?.course??{},lessonKey=studyLessonScope(key);
  if(!/^__zjf_layout_v1:\d+:\d+:\d+$/.test(lessonKey))return {lessonKey:'unclassified',courseKey:'unclassified',courseName:'未归类',lessonName:'未归类的记录'};
  const name=studyCourseName(course);
  return {lessonKey,courseKey:studyCourseScope(key,course),courseName:name==='未归类'?'课程 '+lessonKey.split(':')[2]:name,lessonName:studyLessonName(course,key)};
}
