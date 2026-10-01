// Generated from the compatible installed Lampa source: src/interaction/player/panel/option.js
function setLevels(levels, current){
    if(qualitys && Object.keys(qualitys).length) return

    qualitys = levels

    Html.elem('quality').text(Utils.qualityToText(current))
}

function setQualitys(qs, url){
    if(qs){
        Html.elem('quality').toggleClass('hide', false)

        qualitys = qs

        for(let i in qs){
            let qa = qs[i]
            let qu = typeof qa == 'object' ? qa.url : typeof qa == 'string' ? qa : ''

            if(qu == url){
                Html.elem('quality').text(Utils.qualityToText(i))
                break
            }
        }
    }
}
