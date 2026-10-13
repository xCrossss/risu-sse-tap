// 예전 gist(gistfile1.txt) 내용을 이 파일로 통째로 바꿔 넣는다.
// 이미 저장된 옛 북마크릿은 고칠 수 없으니, 옛 북마크릿이 이걸 eval하다 던진 에러가
// "run err: <아래 문구>" alert로 그대로 뜨게 해서 업데이트를 안내한다.
var LINK = 'https://arca.live/여기에_안내글_주소';
throw new Error('Risu SSE Tap 배포 주소가 GitHub로 옮겨졌습니다.\n아래 아카라이브 글에서 새 북마크릿으로 다시 등록해주세요.\n\n' + LINK);
