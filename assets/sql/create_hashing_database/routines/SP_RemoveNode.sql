create
    definer = root@localhost procedure SP_RemoveNode(IN _ID tinyint)
BEGIN
    delete
    from node_services
    where node_id = _ID;

    delete
    from node
    where node_id = _ID;
end;
